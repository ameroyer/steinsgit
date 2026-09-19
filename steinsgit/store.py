"""The knowledge base.

Everything expensive this tool computes is a pure function of immutable git
objects, so every cache key is content-addressed by SHA. A reading for
(base_sha, head_sha) can never go stale: if either tip moves, the key changes.
That means no TTLs, no invalidation logic, and no way to serve a wrong answer.

Stored in `.steinsgit/knowledge.db` next to the repository (already excluded
from `git status`). SQLite ships with Python, so this costs no dependencies.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS knowledge (
    kind    TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created);
"""

# Oracle answers are worth keeping for a long time; snapshots are cheap to
# rebuild and only useful while the refs still match.
# Row caps, trimmed oldest-first. Anything computed from the repository can be
# recomputed for free, so it is capped. Anything a model wrote is not in here:
# it cost money and cannot be reproduced, so it is kept until you clear it
# yourself with --forget. That is `oracle` (analyses) and `explain` (the
# one-line summaries), both of which are small rows of text.
MAX_ROWS = {"snapshot": 40, "divergence": 8000,
            "mergetree": 4000, "commit": 20000, "meta": 8}


def digest(*parts) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()[:40]


class Store:
    def __init__(self, repo_path: str, enabled: bool = True):
        self.enabled = enabled
        self.path = os.path.join(repo_path, ".steinsgit", "knowledge.db")
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self.stats = {"hit": 0, "miss": 0, "write": 0}
        if not enabled:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            # WAL keeps readers from blocking the writer, which matters because
            # the HTTP server is threaded.
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()
            self._migrate()
        except (OSError, sqlite3.Error):
            self.enabled = False   # a read-only checkout must still work
            self._conn = None

    # Renaming a kind would otherwise orphan every row already paid for, so
    # old names are carried forward instead of abandoned.
    RENAMES = (("describe", "explain"),)

    def _migrate(self) -> None:
        if not self._conn:
            return
        try:
            with self._lock:
                for old, new in self.RENAMES:
                    (n,) = self._conn.execute(
                        "SELECT COUNT(*) FROM knowledge WHERE kind=?", (old,)
                    ).fetchone()
                    if not n:
                        continue
                    # Keep whichever row is newer if both names hold the key.
                    self._conn.execute(
                        "INSERT OR REPLACE INTO knowledge(kind,key,value,created) "
                        "SELECT ?, key, value, created FROM knowledge WHERE kind=? "
                        "AND key NOT IN (SELECT key FROM knowledge WHERE kind=?)",
                        (new, old, new),
                    )
                    self._conn.execute("DELETE FROM knowledge WHERE kind=?", (old,))
                self._conn.commit()
        except sqlite3.Error:
            pass

    # ------------------------------------------------------------------ core

    def get(self, kind: str, key: str):
        if not self._conn:
            return None
        try:
            with self._lock:
                row = self._conn.execute(
                    "SELECT value FROM knowledge WHERE kind=? AND key=?", (kind, key)
                ).fetchone()
                if row is None:
                    self.stats["miss"] += 1
                    return None
                self.stats["hit"] += 1
            return json.loads(row[0])
        except (sqlite3.Error, ValueError):
            return None

    def put(self, kind: str, key: str, value) -> None:
        if not self._conn:
            return
        try:
            payload = json.dumps(value)
        except (TypeError, ValueError):
            return
        try:
            with self._lock:
                self._conn.execute(
                    "INSERT OR REPLACE INTO knowledge(kind,key,value,created) "
                    "VALUES(?,?,?,?)",
                    (kind, key, payload, int(time.time())),
                )
                self._conn.commit()
                self.stats["write"] += 1
            self._trim(kind)
        except sqlite3.Error:
            pass

    def memo(self, kind: str, key: str, produce):
        """Return the cached value, or compute, store and return it."""
        cached = self.get(kind, key)
        if cached is not None:
            return cached
        value = produce()
        self.put(kind, key, value)
        return value

    def _trim(self, kind: str) -> None:
        cap = MAX_ROWS.get(kind)
        if not cap or not self._conn:
            return
        try:
            with self._lock:
                (n,) = self._conn.execute(
                    "SELECT COUNT(*) FROM knowledge WHERE kind=?", (kind,)
                ).fetchone()
                if n <= cap * 1.2:      # trim in batches, not on every write
                    return
                self._conn.execute(
                    "DELETE FROM knowledge WHERE kind=? AND key IN ("
                    "  SELECT key FROM knowledge WHERE kind=? ORDER BY created ASC LIMIT ?)",
                    (kind, kind, int(n - cap)),
                )
                self._conn.commit()
        except sqlite3.Error:
            pass

    def list(self, kind: str, limit: int = 200) -> list[dict]:
        """Every stored value of one kind, newest first, with its key."""
        if not self._conn:
            return []
        try:
            with self._lock:
                rows = self._conn.execute(
                    "SELECT key, value, created FROM knowledge WHERE kind=? "
                    "ORDER BY created DESC LIMIT ?", (kind, limit)
                ).fetchall()
            out = []
            for key, value, created in rows:
                try:
                    payload = json.loads(value)
                except ValueError:
                    continue
                if isinstance(payload, dict):
                    out.append({**payload, "_key": key, "_created": created})
            return out
        except sqlite3.Error:
            return []

    # ----------------------------------------------------------------- admin

    def summary(self) -> dict:
        out = {"enabled": self.enabled, "path": self.path, **self.stats, "kinds": {}}
        if not self._conn:
            return out
        try:
            with self._lock:
                for kind, n, oldest in self._conn.execute(
                    "SELECT kind, COUNT(*), MIN(created) FROM knowledge GROUP BY kind"
                ):
                    out["kinds"][kind] = {"rows": n, "oldest": oldest}
                out["bytes"] = os.path.getsize(self.path) if os.path.exists(self.path) else 0
        except (sqlite3.Error, OSError):
            pass
        return out

    def spend(self) -> dict:
        """Running total of tokens and dollars spent on model calls.

        Kept as one accumulator row. Adding up every stored answer on each read
        would mean parsing thousands of JSON blobs on a repository that has
        been used for a while.
        """
        total = self.get("meta", "spend")
        if total:
            return total
        return self._rebuild_spend()

    def add_spend(self, tokens: int, cost: float, at: int) -> None:
        total = self.get("meta", "spend") or self._rebuild_spend()
        self.put("meta", "spend", {
            "calls": total["calls"] + 1,
            "tokens": total["tokens"] + (tokens or 0),
            "costUsd": round(total["costUsd"] + (cost or 0.0), 6),
            "lastAt": max(total["lastAt"], at or 0),
        })

    def _rebuild_spend(self) -> dict:
        """One full pass, done once, for a database written before this existed."""
        totals = {"calls": 0.0, "tokens": 0, "costUsd": 0.0, "lastAt": 0}
        for kind in ("oracle", "explain"):
            for row in self.list(kind, limit=20000):
                # A summary is one of a batch that cost a single call, and it
                # stored its share of that call's tokens and money. Counting
                # each row as a call would report a run of ten calls as four
                # hundred, and price the next one off that.
                totals["calls"] += 1 / (row.get("batch") or 1)
                totals["tokens"] += (row.get("usage") or {}).get("total") or 0
                totals["costUsd"] += row.get("costUsd") or 0.0
                totals["lastAt"] = max(totals["lastAt"], row.get("at") or row.get("_created") or 0)
        totals["calls"] = round(totals["calls"])
        totals["costUsd"] = round(totals["costUsd"], 6)
        self.put("meta", "spend", totals)
        return totals

    def clear(self) -> None:
        if not self._conn:
            return
        try:
            with self._lock:
                self._conn.execute("DELETE FROM knowledge")
                self._conn.commit()
        except sqlite3.Error:
            pass
