"""Session state: one repository, parsed once and remembered.

Every expensive result is memoised in the knowledge base under a key derived
from the SHAs it was computed from, so a second run of the tool against an
unchanged repository does almost no git work at all.
"""

from __future__ import annotations

import threading
import time

from . import divergence
from .gitdata import GitError, Repo, parallel_map
from .layout import build as build_layout
from .forge import Forge
from .store import Store, digest
from . import worktree


class Session:
    def __init__(
        self,
        path: str,
        days: int = 90,
        max_commits: int = 2000,
        main: str | None = None,
        model: str = "sonnet",
        explain_model: str = "haiku",
        include_remotes: bool = True,
        cache: bool = True,
    ):
        self.repo = Repo(path)
        self.days = days
        self.max_commits = max_commits
        self.main_override = main
        self.include_remotes = include_remotes
        self.store = Store(self.repo.path, enabled=cache)
        worktree.ensure_excluded(self.repo)
        saved = self.store.get("settings", "app") or {}
        self.model = saved.get("model", model)
        self.explain_model = saved.get("explainModel", explain_model)
        self.forge_override = saved.get("forge", "auto")
        self.ask_on_open = saved.get("askOnOpen", True)
        self._tracking: dict[str, dict] = {}
        # How much of what is loaded a run is allowed to spend money on. The
        # window decides what you can see; these decide what gets read by a
        # model, which is a separate and much more expensive question. 0 is no
        # limit.
        self.explain_limit = saved.get("explainLimit", 0)
        self.branch_limit = saved.get("branchLimit", 0)
        self.forge = Forge(self.repo, self.forge_override)
        self._lock = threading.Lock()
        self._snapshot: dict | None = None

    # ------------------------------------------------------------------ scan

    def snapshot(self, force: bool = False) -> dict:
        with self._lock:
            if self._snapshot is None or force:
                self._snapshot = self._scan(force=force)
            return self._snapshot

    def _fingerprint(self, refs, main: str) -> str:
        """Identity of a scan: every ref tip plus the window parameters.

        If any branch moves, the fingerprint changes and the snapshot is
        rebuilt. If nothing moved, the stored one is still exactly correct.
        """
        tips = ";".join(f"{r.name}={r.sha}" for r in sorted(refs, key=lambda r: r.name))
        # Bump this whenever the shape of a snapshot changes, not just when
        # the repository does. A saved snapshot is replayed verbatim, so a new
        # field added to the graph or to a branch is invisible to anyone with
        # an existing cache until the key stops matching.
        return digest("snap-v9", tips, main, self.days, self.max_commits, self.include_remotes)

    def _scan(self, force: bool = False) -> dict:
        started = time.time()
        repo = self.repo
        main = repo.main_branch(self.main_override)
        refs = repo.refs(include_remotes=self.include_remotes)

        # One branch, one line. A remote-tracking ref whose local branch is
        # also here is not a second world line, it is the same branch seen from
        # somewhere else - even when the two have drifted apart. Drawing both
        # says a repository has twice as many branches as it does. The local
        # one stays, because it is the one you can check out and merge; what
        # the remote is doing becomes a fact recorded against it, below.
        local = {r.name: r for r in refs if not r.remote}
        tracking = {}
        for r in refs:
            if not r.remote:
                continue
            base = _strip_remote(r.name)
            if base in local:
                tracking[base] = r
        refs = [r for r in refs if not (r.remote and _strip_remote(r.name) in local)]

        key = self._fingerprint(refs, main)
        cached = None if force else self.store.get("snapshot", key)
        if cached:
            # The snapshot carries the tracking facts; branch_detail reads them
            # off the session, so restore them rather than leaving them behind
            # with the scan that computed them.
            self._tracking = {
                b["name"]: b["tracking"]
                for b in cached.get("branches", []) if b.get("tracking")
            }
            cached["repo"].update(self._live_fields(started, from_cache=True))
            return cached

        commits = repo.log(since_days=self.days, max_commits=self.max_commits)
        in_window = {c.sha for c in commits}

        # Keep refs whose tip fell outside the window visible by pulling that
        # one commit back in, otherwise a quiet branch silently vanishes.
        missing = sorted({r.sha for r in refs} - in_window)
        if missing:
            for c in repo.log_at(missing):
                if c.sha not in in_window:
                    commits.append(c)
                    in_window.add(c.sha)
            commits.sort(key=lambda c: -c.ts)

        refs = [r for r in refs if r.sha in in_window]
        self._tracking = self._tracking_view(tracking, {r.name for r in refs})
        stats = repo.commit_stats(self.days, self.max_commits)

        main_sha = repo.rev_parse(main) or main
        now = int(time.time())
        readings = parallel_map(
            lambda r: (r.name, self._divergence(main, r.name, main_sha, r.sha, now)),
            refs,
        )
        by_name = dict(readings)

        # Measured before the layout, not after: the canvas places a column by
        # how far its branches have diverged, so the packer has to know that
        # before it decides which branches share one.
        graph = build_layout(
            commits, refs, main, stats,
            {name: r["value"] for name, r in by_name.items()},
        )

        branches = []
        for entry in graph["branches"]:
            reading = by_name.get(entry["name"])
            if reading is None:
                reading = divergence.compute(repo, main, main, now=now)
            branches.append(
                {
                    **entry,
                    "label": short_label(entry["name"]),
                    "isWorldline": is_worldline(entry["name"]),
                    # Names only, so the renderer can draw a line back to each
                    # branch this one was built from.
                    "parents": [
                        m["name"] for m in
                        self.merged_from(entry["tip"], entry["name"], graph)
                    ] if is_worldline(entry["name"]) and entry.get("tip") else [],
                    "divergence": reading["value"],
                    "display": reading["display"],
                    "field": reading["field"],
                    "conflictRisk": reading["conflictRisk"],
                    "ahead": reading["raw"].get("ahead", 0),
                    "behind": reading["raw"].get("behind", 0),
                    "summary": divergence.explain(reading),
                    "url": self.forge.branch(entry["name"]),
                    "tracking": self._tracking.get(entry["name"]),
                }
            )
        branches.sort(key=lambda b: (not b["isMain"], -b["divergence"]))

        snap = {
            "repo": {
                "path": repo.path,
                "name": repo.path.rstrip("/").split("/")[-1],
                "main": main,
                "mainLabel": short_label(main),
                "head": repo.head_branch(),
                "days": self.days,
                "maxCommits": self.max_commits,
                "model": self.model,
                "commitCount": len(commits),
                "branchCount": len(branches),
            },
            "graph": graph,
            "branches": branches,
        }
        self.store.put("snapshot", key, snap)
        snap["repo"].update(self._live_fields(started, from_cache=False))
        return snap

    def _tracking_view(self, tracking: dict, drawn: set[str]) -> dict:
        """How each local branch stands against the remote it was folded with.

        Answers the question the second line used to answer by being there:
        has anyone else moved this, and does my copy still match theirs.
        """
        def measure(item):
            name, ref = item
            ahead, behind = self.repo.ahead_behind(ref.name, name)
            return name, {
                "remote": ref.name,
                "sha": ref.sha,
                "short": ref.sha[:7],
                "ts": ref.ts,
                # Relative to the remote: what I have that they do not, and
                # what they have that I do not.
                "ahead": ahead,
                "behind": behind,
                "inSync": ahead == 0 and behind == 0,
            }

        wanted = [(n, r) for n, r in tracking.items() if n in drawn]
        return dict(parallel_map(measure, wanted)) if wanted else {}

    def _live_fields(self, started: float, from_cache: bool) -> dict:
        """Values that must never be frozen into a stored snapshot."""
        return {
            "scanMs": int((time.time() - started) * 1000),
            "scannedAt": int(time.time()),
            "fromCache": from_cache,
            "cache": self.store.summary(),
            "forge": self.forge.to_json(),
            "model": self.model,
            "explainModel": self.explain_model,
        }

    # --------------------------------------------------------------- queries

    def _divergence(self, base: str, head: str, base_sha: str, head_sha: str, now: int) -> dict:
        """Memoised divergence. The key is both SHAs, so it can never be stale."""
        pending = self._pending_merge(head)
        if pending:
            # Keyed on the unresolved count too, so fixing a conflict by hand
            # changes the reading rather than serving a stale one.
            return self.store.memo(
                "divergence",
                digest("div-pend-v1", base_sha, head_sha,
                       pending["incoming"], pending["unresolved"]),
                lambda: divergence.compute_pending_merge(
                    self.repo, base, head, pending["incoming"],
                    pending["unresolved"], now=now),
            )
        return self.store.memo(
            "divergence",
            digest("div-v2", base_sha, head_sha),
            lambda: divergence.compute(self.repo, base, head, now=now),
        )

    def _pending_merge(self, branch: str) -> dict | None:
        """An open merge sitting in a merge-test worktree, if there is one."""
        if not is_worldline(branch):
            return None
        record = self.worldline_record(branch) or {}
        incoming = record.get("incoming")
        if not incoming or not self.repo.rev_parse(incoming):
            return None
        state = worktree.status(self.repo, branch, record.get("path"))
        if not state or not state.get("mergeInProgress"):
            return None
        return {"incoming": incoming, "unresolved": state.get("unresolvedCount", 0)}

    def reading(self, head: str, base: str | None = None) -> dict:
        base = base or self.main()
        bs, hs = self.repo.rev_parse(base), self.repo.rev_parse(head)
        if not bs or not hs:
            raise GitError(f"unknown ref: {head if not hs else base}")
        return self._divergence(base, head, bs, hs, int(time.time()))

    def main(self) -> str:
        return self.snapshot()["repo"]["main"]

    def commit_detail(self, sha: str) -> dict:
        full = self.repo.rev_parse(sha)
        if not full:
            raise GitError(f"unknown commit: {sha}")
        # Versioned: rows cached by an older build can carry fields that have
        # since been removed, and a cache must never resurrect them.
        detail = self.store.memo(
            "commit", digest("commit-v2", full), lambda: self.repo.commit_detail(full))
        # A saved explanation belongs to the commit, so it travels with it
        # wherever the commit is shown.
        files = [
            {
                **f,
                "url": self.forge.file_in_commit(full, f["path"]),
                # A merge has no diff to anchor into, so the file as it stands
                # at this commit is the only link that goes anywhere useful.
                "blobUrl": self.forge.blob(full, f["path"]),
            }
            for f in detail.get("files", [])
        ]
        return {
            **detail,
            "files": files,
            "summary": self.summary_for(full),
            "explainCost": self.explain_cost(full),
            "url": self.forge.commit(full),
        }

    def explain_key(self, kind: str, ident: str, sha: str) -> str:
        """Where a one-line summary is stored.

        A commit's summary is filed under its own SHA, so it follows the commit
        wherever it is shown. A branch's summary is about the branch - what the
        whole line of work is for - and not about the commit its tip happens to
        sit on, so filing it under that SHA made the two overwrite each other:
        after a full run, every branch tip carried whichever of the two was
        written last, and a branch would show a description of a single commit
        or a commit would show a description of a whole branch.

        Branch keys carry the name as well as the tip, because several branches
        can share a tip and they do not share a description.
        """
        return sha if kind == "commits" else digest("branch-explain-v1", ident, sha)

    def branch_summary(self, name: str, tip: str | None = None) -> str | None:
        """Pass `tip` when you already have it. Asking git for it costs a
        subprocess, and the one caller that wants every branch at once was
        spawning one per branch to learn what the snapshot had already told
        it."""
        tip = tip or self.repo.rev_parse(name)
        if not tip:
            return None
        row = self.store.get("explain", self.explain_key("branches", name, tip))
        return (row or {}).get("summary")

    def summary_for(self, sha: str) -> str | None:
        row = self.store.get("explain", self.explain_key("commits", sha, sha))
        return row.get("summary") if row else None

    def explain_cost(self, sha: str) -> dict | None:
        """What the stored explanation for this commit cost to produce."""
        row = self.store.get("explain", self.explain_key("commits", sha, sha))
        if not row or not row.get("summary"):
            return None
        return {
            "model": row.get("model"),
            "costUsd": row.get("costUsd"),
            "usage": row.get("usage"),
            "at": row.get("at"),
            "batch": row.get("batch"),
        }

    def branch_detail(self, name: str) -> dict:
        main = self.main()
        reading = self.reading(name, main)
        # The reference branch has no base to diff against; on a young
        # repository `main~60` may not even exist, so just take its history.
        commits = self.repo.branch_log(None if name == main else main, name, limit=60)
        for c in commits:
            c["summary"] = self.summary_for(c["sha"])
            c["impact"] = divergence.commit_impact(
                c.get("insertions", 0), c.get("deletions", 0), c.get("files", 0)
            )
            c["url"] = self.forge.commit(c["sha"])
        # Relative size is scaled across the group, so it needs them all first.
        divergence.scale_rel([c["impact"] for c in commits])
        tip = self.repo.rev_parse(name)
        return {
            "name": name,
            "label": short_label(name),
            "isMain": name == main,
            "isWorldline": is_worldline(name),
            "tracking": self._tracking.get(name),
            "mergedFrom": self.merged_from(tip, name) if tip else [],
            "worktree": self._worktree_view(name, tip) if is_worldline(name) else None,
            "summary": self.branch_summary(name, tip),
            "url": self.forge.branch(name),
            "compareUrl": None if name == main else self.forge.compare(main, name),
            "reading": reading,
            "explain": divergence.explain(reading),
            "commits": commits,
        }

    def record_worldline(self, result: dict) -> None:
        """Remember what a created branch was made from.

        A conflicted merge leaves the branch sitting on its base with nothing
        committed, so the commit graph cannot say where it came from. Without
        this record such a branch looks like it appeared from nowhere.
        """
        if not result.get("ok") or not result.get("branch"):
            return
        self.store.put("worldline", result["branch"], {
            "base": result.get("base"),
            "incoming": result.get("incoming"),
            "path": result.get("path"),
            "clean": result.get("clean"),
            "at": int(time.time()),
        })

    def worldline_record(self, branch: str) -> dict | None:
        """Provenance for a merge-test branch, recovering it if never recorded."""
        record = self.store.get("worldline", branch)
        if record and (record.get("base") or record.get("incoming")):
            return record
        if not is_worldline(branch):
            return record
        recovered = worktree.recover_provenance(self.repo, branch)
        if recovered:
            self.store.put("worldline", branch, {**recovered, "at": int(time.time())})
        return recovered

    def _worktree_view(self, name: str, tip: str | None) -> dict | None:
        """Merge-test worktree state, with a link per conflicted file."""
        record = self.worldline_record(name) or {}
        state = worktree.status(self.repo, name, record.get("path"))
        if not state:
            return None
        rev = tip or name
        state["unresolved"] = [
            {**f, "url": self.forge.blob(rev, f["path"])} for f in state.get("unresolved", [])
        ]
        state["base"] = record.get("base")
        state["incoming"] = record.get("incoming")
        return state

    def merged_from(self, tip: str, exclude: str, graph: dict | None = None) -> list[dict]:
        """Name the branches this one was built from.

        Prefer the recorded provenance, because a merge that stopped on a
        conflict has no merge commit to read parents from.
        """
        record = self.worldline_record(exclude)
        if record and (record.get("base") or record.get("incoming")):
            out = []
            for role, ref in (("base", record.get("base")), ("merged in", record.get("incoming"))):
                if not ref or ref == exclude:
                    continue
                sha = self.repo.rev_parse(ref)
                out.append({
                    "name": ref,
                    "label": short_label(ref),
                    "role": role,
                    "sha": (sha or "")[:10],
                    "subject": "",
                    "url": self.forge.branch(ref),
                    "commitUrl": self.forge.commit(sha) if sha else None,
                })
            if out:
                return out

        # `graph` is passed in during a scan: calling snapshot() there would
        # re-enter a lock we already hold.
        graph = graph if graph is not None else self.snapshot()["graph"]
        by_sha = {c["sha"]: c for c in graph["commits"]}
        tip_commit = by_sha.get(tip)
        if not tip_commit or len(tip_commit.get("parents", [])) < 2:
            return []
        out, seen = [], set()
        for parent in tip_commit["parents"]:
            pc = by_sha.get(parent)
            owner = pc.get("branch") if pc else None
            if not owner or owner == exclude or owner in seen:
                continue
            seen.add(owner)
            out.append({
                "name": owner,
                "label": short_label(owner),
                "role": "base" if parent == tip_commit["parents"][0] else "merged in",
                "sha": parent[:10],
                "subject": pc.get("subject", ""),
                "url": self.forge.branch(owner),
                "commitUrl": self.forge.commit(parent),
            })
        return out

    def merge_test(self, a: str, b: str) -> dict:
        """Real in-memory merge, memoised on the pair of tip SHAs."""
        sa, sb = self.repo.rev_parse(a), self.repo.rev_parse(b)
        if not sa or not sb:
            raise GitError(f"unknown ref: {a if not sa else b}")
        # The engine is part of the key: a saved answer from the old-git
        # fallback must not be replayed as if the real thing had produced it,
        # and upgrading git should re-run the test rather than serve the
        # approximation forever.
        engine = "native" if self.repo.supports_merge_tree() else "byhand"
        return self.store.memo(
            "mergetree", digest("mt-v2", sa, sb, engine),
            lambda: self.repo.merge_tree(a, b),
        )

    def compare(self, a: str, b: str) -> dict:
        reading = self.reading(b, a)
        merge = self.merge_test(a, b)
        return {
            "a": a, "b": b,
            "aLabel": short_label(a), "bLabel": short_label(b),
            "reading": reading,
            "explain": divergence.explain(reading),
            "merge": merge,
            "commitsA": self.repo.branch_log(b, a, limit=40),
            "commitsB": self.repo.branch_log(a, b, limit=40),
        }

    # Batch size used when explaining commits, and the point at which a first
    # run is big enough to be worth warning about.
    EXPLAIN_BATCH = 40
    DESCRIBE_BATCH = 30
    BIG_RUN_COMMITS = 150

    def run_targets(self, snap: dict | None = None) -> tuple[list[str], list[str]]:
        """Exactly what a full run would touch, in the order it would pick.

        Newest commits first, and branches by how recently they were touched -
        if you cap a run at a hundred, the hundred you want are the recent
        ones. Computed here and handed to the page, so what gets priced and
        what gets run cannot be two different lists.
        """
        snap = snap or self.snapshot()
        commits = [c["sha"] for c in snap["graph"]["commits"]]      # newest first
        if self.explain_limit:
            commits = commits[:self.explain_limit]
        branches = sorted(snap["branches"],
                          key=lambda b: (not b["isMain"], -(b.get("ts") or 0)))
        if self.branch_limit:
            branches = branches[:self.branch_limit]
        return commits, [b["name"] for b in branches]

    def work_plan(self) -> dict:
        """What a full analysis of this repository would involve, and cost.

        Estimates come from this repository's own past calls where there are
        any. With no history we report the volume of work and say plainly that
        we cannot price it, rather than inventing a number.
        """
        snap = self.snapshot()
        commits, branch_names = self.run_targets(snap)
        todo_commits = [sha for sha in commits if not self.summary_for(sha)]

        analysed = set()
        for row in self.store.list("oracle", limit=500):
            analysed.update(row.get("refs") or [])
        todo_branches = [n for n in branch_names if n not in analysed]
        tip_of = {b["name"]: b.get("tip") for b in snap["branches"]}

        batches = -(-len(todo_commits) // self.EXPLAIN_BATCH)
        # A branch needs two things written about it: the one line the branch
        # page shows, batched with the cheap model, and the long review. The
        # estimate has to count both or it under-prices a full run.
        todo_desc = [n for n in branch_names
                     if not self.branch_summary(n, tip_of.get(n))]
        desc_batches = -(-len(todo_desc) // self.DESCRIBE_BATCH)
        # Priced from this repository's own past calls, using the running
        # totals the store already keeps. Averaging the stored answers instead
        # would divide a batch's tokens by the number of summaries in it and
        # then multiply by the number of calls, which prices a full run well
        # under what it comes to.
        spend = self.store.spend()
        calls = batches + desc_batches + len(todo_branches)
        estimate = None
        if spend["calls"] >= 2:
            per_call = spend["tokens"] / spend["calls"]
            per_cost = spend["costUsd"] / spend["calls"]
            estimate = {
                "calls": calls,
                "tokens": int(per_call * calls),
                "costUsd": round(per_cost * calls, 4),
                "basedOn": spend["calls"],
            }

        # What has already been paid for, so a second run is an informed
        # decision rather than a repeat of the first one. Both ends of the
        # window come from aggregates: finding two timestamps by reading every
        # answer ever stored costs a JSON parse per row, and there can be tens
        # of thousands of them.
        kinds = self.store.summary().get("kinds", {})
        oldest = [k["oldest"] for name, k in kinds.items()
                  if name in ("explain", "oracle") and k.get("oldest")]
        done = {
            "commitsExplained": len(commits) - len(todo_commits),
            "branchesDescribed": len(branch_names) - len(todo_desc),
            "branchesAnalysed": len(branch_names) - len(todo_branches),
            "firstAt": min(oldest) if oldest else None,
            "lastAt": spend["lastAt"] or None,
            "spend": spend,
        }

        return {
            "done": done,
            "commitsTotal": len(commits),
            "commitsLoaded": len(snap["graph"]["commits"]),
            "commitsToExplain": len(todo_commits),
            "explainLimit": self.explain_limit,
            "branchLimit": self.branch_limit,
            "branchesTotal": len(branch_names),
            "branchesLoaded": len(snap["branches"]),
            "branchesToAnalyse": len(todo_branches),
            "batches": batches,
            "describeBatches": desc_batches,
            "branchesToDescribe": len(todo_desc),
            "calls": calls,
            "estimate": estimate,
            "large": len(todo_commits) >= self.BIG_RUN_COMMITS,
            "days": self.days,
            "maxCommits": self.max_commits,
            "explainModel": self.explain_model,
            "model": self.model,
            "askOnOpen": self.ask_on_open,
            "fresh": not analysed and not (len(commits) - len(todo_commits)),
        }

    def _persisted(self) -> dict:
        """The settings that survive a restart, in one place."""
        return {
            "model": self.model,
            "explainModel": self.explain_model,
            "forge": self.forge_override,
            "askOnOpen": self.ask_on_open,
            "explainLimit": self.explain_limit,
            "branchLimit": self.branch_limit,
        }

    def settings(self) -> dict:
        return {
            **self._persisted(),
            "forgeInfo": self.forge.to_json(),
            "spend": self.store.spend(),
            "scannedAt": (self._snapshot or {}).get("repo", {}).get("scannedAt"),
            "days": self.days,
            "maxCommits": self.max_commits,
        }

    def update_settings(self, model=None, explain_model=None, forge=None,
                        ask_on_open=None, explain_limit=None, branch_limit=None) -> dict:
        if model:
            self.model = model
        if explain_model:
            self.explain_model = explain_model
        if forge is not None:
            self.forge_override = forge
            self.forge = Forge(self.repo, forge)
        if ask_on_open is not None:
            self.ask_on_open = bool(ask_on_open)
        if explain_limit is not None:
            self.explain_limit = max(0, int(explain_limit))
        if branch_limit is not None:
            self.branch_limit = max(0, int(branch_limit))
        self.store.put("settings", "app", self._persisted())
        return self.settings()

    def set_window(self, days: int | None = None, max_commits: int | None = None) -> dict:
        if days is not None:
            self.days = max(0, days) or None
        if max_commits is not None:
            self.max_commits = max(50, max_commits)
        return self.snapshot(force=True)


def _strip_remote(name: str) -> str:
    """'origin/feature/x' -> 'feature/x'. The first segment of a
    remote-tracking ref is the remote's name, whatever it is called."""
    return name.split("/", 1)[1] if "/" in name else name


WORLDLINE_PREFIX = "worldline/"


def is_worldline(name: str) -> bool:
    return bool(name) and name.startswith(WORLDLINE_PREFIX)


def short_label(name: str) -> str:
    """`origin/feature/x` reads as `feature/x`; the remote is shown as a badge.

    A branch this tool created is named `worldline/<base>--<incoming>`, which is
    long and repetitive. Show it as `base ← incoming` instead.
    """
    if not name:
        return ""
    if is_worldline(name):
        body = name[len(WORLDLINE_PREFIX):]
        if "--" in body:
            base, _, incoming = body.partition("--")
            return f"{base} ← {incoming}"
        return body
    for prefix in ("origin/", "upstream/", "refs/heads/", "refs/remotes/"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name
