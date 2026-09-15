"""API route handlers.

Split out of `server.py` so that file is only HTTP plumbing: sockets, headers,
Server-Sent Events, static files and the same-origin check. Everything here
answers a route and knows nothing about how the request arrived.

`Routes` is mixed into the request handler, so `self` is the handler: the
response helpers (`_json`, `_error`, `_sse`) and `self.sess` come from there.
"""

from __future__ import annotations

import os
import time
import traceback
from urllib.parse import urlparse

from . import export, oracle, worktree
from .divergence import explain
from .gitdata import GitError, parallel_map
from .store import digest


class Routes:
    def do_GET(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        try:
            # Exports carry everything the analysis wrote, so they are as
            # protected as the API: a rebound hostname gets nothing at all.
            if not self._local_request():
                return self._error("this endpoint only answers its own page", 403)
            if route.startswith("/api/"):
                self._api_get(route)
            else:
                self._static(route)
        except GitError as exc:
            self._error(str(exc), 400)
        except BrokenPipeError:
            pass
        except Exception as exc:  # pragma: no cover - surface bugs in the UI
            traceback.print_exc()
            self._error(f"{type(exc).__name__}: {exc}", 500)

    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        try:
            if not self._local_request():
                return self._error("this endpoint only answers its own page", 403)
            if route == "/api/worktree":
                self._create_worktree()
            elif route == "/api/settings":
                body = self._body()
                self._json(self.sess.update_settings(
                    model=body.get("model"),
                    explain_model=body.get("explainModel"),
                    forge=body.get("forge"),
                    ask_on_open=body.get("askOnOpen"),
                    explain_limit=body.get("explainLimit"),
                    branch_limit=body.get("branchLimit"),
                ))
            elif route == "/api/export":
                self._export()
            elif route == "/api/window":
                body = self._body()
                snap = self.sess.set_window(
                    days=_int(body.get("days")), max_commits=_int(body.get("maxCommits"))
                )
                self._json(snap)
            else:
                self._error("unknown endpoint", 404)
        except GitError as exc:
            self._error(str(exc), 400)
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            self._error(f"{type(exc).__name__}: {exc}", 500)

    # ------------------------------------------------------------------- API

    def _api_get(self, route: str) -> None:
        q = self._query()

        if route == "/api/state":
            self._json(self.sess.snapshot(force=q.get("refresh") == "1"))

        elif route == "/api/branch":
            name = q.get("name")
            if not name:
                return self._error("missing name")
            self._json(self.sess.branch_detail(name))

        elif route == "/api/commit":
            sha = q.get("sha")
            if not sha:
                return self._error("missing sha")
            self._json(self.sess.commit_detail(sha))

        elif route == "/api/compare":
            a, b = q.get("a"), q.get("b")
            if not a or not b:
                return self._error("need both a and b")
            self._json(self.sess.compare(a, b))

        elif route == "/api/history":
            ref = q.get("ref")
            rows = self.sess.store.list("oracle", limit=300)
            if ref:
                rows = [r for r in rows if ref in (r.get("refs") or [])]
            # The full text is heavy; the list view only needs a preview.
            self._json({"history": [
                {k: v for k, v in r.items() if k != "text"} |
                {"preview": (r.get("text") or "")[:180], "chars": len(r.get("text") or "")}
                for r in rows[:40]
            ]})

        elif route == "/api/analysis":
            rows = self.sess.store.list("oracle", limit=300)
            wanted = q.get("key")
            hit = next((r for r in rows if r.get("_key") == wanted), None)
            if not hit:
                return self._error("no such analysis", 404)
            self._json(hit)

        elif route == "/api/explain/stream":
            self._explain_stream(q)

        elif route == "/api/plan":
            self._json(self.sess.work_plan())

        elif route == "/api/targets":
            # The exact lists a run would touch. The page asks for these rather
            # than working them out again, so what was priced is what runs.
            commits, branches = self.sess.run_targets()
            self._json({"commits": commits, "branches": branches})

        elif route == "/api/settings":
            self._json(self.sess.settings())

        elif route == "/api/worktree/check":
            a, b = q.get("a"), q.get("b")
            if not a or not b:
                return self._error("need both a and b")
            records = {r["_key"]: r for r in self.sess.store.list("worldline", limit=500)}
            self._json({"existing": worktree.find_existing(self.sess.repo, a, b, records)})

        elif route == "/api/worktrees":
            self._json({"worktrees": worktree.listing(self.sess.repo)})

        elif route == "/api/oracle/branch":
            self._oracle_branch(q.get("name"), q.get("force") == "1")

        elif route == "/api/oracle/merge":
            self._oracle_merge(q.get("a"), q.get("b"), q.get("force") == "1")

        else:
            self._error("unknown endpoint", 404)

    def _oracle_branch(self, name: str | None, force: bool = False) -> None:
        if not name:
            return self._error("missing name")
        sess = self.sess
        main = sess.main()
        main_sha = sess.repo.rev_parse(main) or main
        head_sha = sess.repo.rev_parse(name)
        if not head_sha:
            return self._error(f"unknown ref: {name}")

        key = digest("oracle-branch-v2", sess.model, main_sha, head_sha)
        self._sse_open()
        if self._replay(key, force, f"analysing {name}"):
            return

        detail = sess.branch_detail(name)
        reading = detail["reading"]
        prompt = oracle.branch_prompt(
            base=main, head=name, reading=reading,
            explain_text=detail["explain"], commits=detail["commits"],
            contested=reading["raw"].get("contested", []),
        )
        self._sse({"type": "status", "message": f"analysing {name}"})
        self._pump(prompt, key, {
            "kind": "branch", "refs": [name], "title": f"branch · {name}",
        })

    def _oracle_merge(self, a: str | None, b: str | None, force: bool = False) -> None:
        if not a or not b:
            return self._error("need both a and b")
        sess = self.sess
        sa, sb = sess.repo.rev_parse(a), sess.repo.rev_parse(b)
        if not sa or not sb:
            return self._error(f"unknown ref: {a if not sa else b}")

        self._sse_open()
        # The deterministic verdict goes out first: it is instant and correct,
        # so the pane is useful even when the model is slow or unavailable.
        try:
            cmp_result = sess.compare(a, b)
        except GitError as exc:
            self._sse({"type": "error", "message": str(exc)})
            self._sse({"type": "done"})
            return
        if not self._sse({"type": "merge", "data": cmp_result["merge"],
                          "reading": cmp_result["reading"]}):
            return

        key = digest("oracle-merge-v2", sess.model, sa, sb)
        if self._replay(key, force, f"comparing {a} and {b}"):
            return

        prompt = oracle.merge_prompt(
            a=a, b=b, reading=cmp_result["reading"], explain_text=cmp_result["explain"],
            merge=cmp_result["merge"], commits_a=cmp_result["commitsA"],
            commits_b=cmp_result["commitsB"],
        )
        self._sse({"type": "status", "message": f"comparing {a} and {b}"})
        self._pump(prompt, key, {
            "kind": "merge", "refs": [a, b], "title": f"merge · {a} ← {b}",
        })

    def _replay(self, key: str, force: bool, header: str) -> bool:
        """Serve a remembered analysis instantly. Returns True if it did."""
        if force:
            return False
        cached = self.sess.store.get("oracle", key)
        if not cached or not cached.get("text"):
            return False
        self._sse({"type": "status", "message": header})
        self._sse({"type": "cached", "at": cached.get("at"),
                   "model": cached.get("model"), "partial": cached.get("partial")})
        self._sse({"type": "text", "text": cached["text"]})
        self._sse({"type": "done"})
        return True

    def _pump(self, prompt: str, key: str | None = None, meta: dict | None = None) -> None:
        """Stream an answer to the browser, and keep it whatever happens.

        Closing the tab used to throw the answer away mid-flight. The call has
        already been made and already been paid for by then, so the only thing
        that achieves is making you buy it a second time. We stop writing to a
        browser that has gone, but we keep reading to the end and we save what
        we get.
        """
        sess = self.sess
        chunks: list[str] = []
        final = None
        listening = True
        stream = oracle.run(prompt, cwd=sess.repo.path, model=sess.model)
        try:
            for event in stream:
                if event["type"] == "text":
                    chunks.append(event["text"])
                elif event["type"] == "result":
                    final = event
                    # No deltas arrived: the aggregate result is the answer.
                    if event.get("text") and not chunks:
                        chunks.append(event["text"])
                if listening and not self._sse(event):
                    listening = False
        finally:
            stream.close()
        text = "".join(chunks).strip()
        if key and text:
            self.sess.store.put("oracle", key, {
                **(meta or {}),
                "text": text,
                "at": int(time.time()),
                # True when the model never reported a result: the text is what
                # arrived before it stopped, so it is worth keeping but must not
                # be replayed as though it were the whole answer.
                "partial": final is None,
                "model": (final or {}).get("model") or sess.model,
                "costUsd": (final or {}).get("costUsd"),
                "usage": (final or {}).get("usage"),
                "durationMs": (final or {}).get("durationMs"),
            })
            self.sess.store.add_spend(
                ((final or {}).get("usage") or {}).get("total") or 0,
                (final or {}).get("costUsd") or 0.0, int(time.time()))

    def _explain_stream(self, q: dict) -> None:
        kind = q.get("kind") or "commits"
        ids = [i for i in (q.get("ids") or "").split(",") if i][:60]
        force = q.get("force") == "1"
        if kind not in ("commits", "branches") or not ids:
            return self._error("need kind and ids")

        sess = self.sess
        self._sse_open()
        summaries: dict[str, str] = {}
        pending: list[dict] = []
        # Resolved in parallel: sixty serial rev-parse subprocesses is a
        # visible pause before the stream even opens.
        resolved = dict(parallel_map(
            lambda i: (i, sess.repo.rev_parse(i)), ids))
        for ident in ids:
            sha = resolved.get(ident)
            if not sha:
                continue
            key = sess.explain_key(kind, ident, sha)
            cached = None if force else sess.store.get("explain", key)
            if cached and cached.get("summary"):
                summaries[ident] = cached["summary"]
                continue
            text, size = self._explain_line(kind, ident, sha)
            pending.append({"id": ident, "sha": sha, "key": key,
                            "text": text, "size": size})

        if not self._sse({"type": "start", "total": len(ids),
                          "reused": len(ids) - len(pending), "todo": len(pending),
                          "model": sess.explain_model}):
            return
        if not pending:
            self._sse({"type": "done", "summaries": summaries, "fromCache": len(summaries),
                       "generated": 0})
            return

        stream = oracle.explain_stream(
            [{k: p[k] for k in ("id", "text", "size")} for p in pending],
            kind=kind, cwd=sess.repo.path, model=sess.explain_model,
        )
        final = {}
        listening = True
        try:
            for event in stream:
                if event.get("type") == "done":
                    final = event
                    break
                # As in _pump: a browser that has gone is no reason to discard
                # a batch of summaries that has already been paid for.
                if listening and not self._sse(event):
                    listening = False
        finally:
            stream.close()

        fresh = final.get("summaries") or {}
        written = [p for p in pending if fresh.get(p["id"])]
        share = max(1, len(written))
        usage = final.get("usage") or {}
        for p in written:
            summaries[p["id"]] = fresh[p["id"]]
            sess.store.put("explain", p["key"], {
                "summary": fresh[p["id"]],
                "at": int(time.time()),
                "model": final.get("model"),
                # The batch cost is shared out, so the running total stays real.
                "costUsd": round((final.get("costUsd") or 0) / share, 6),
                "usage": {"total": (usage.get("total") or 0) // share},
                "batch": len(written),
            })
        if written:
            sess.store.add_spend(usage.get("total") or 0,
                                 final.get("costUsd") or 0.0, int(time.time()))
        self._sse({
            "type": "done", "summaries": summaries,
            "generated": len(written), "fromCache": len(ids) - len(pending),
            "model": final.get("model"), "costUsd": final.get("costUsd"),
            "usage": usage, "durationMs": final.get("durationMs"),
            "error": final.get("error"),
        })

    def _explain_line(self, kind: str, ident: str, sha: str) -> tuple[str, str]:
        """Context line plus a size band, which sets how long the reply may be."""
        if kind == "branches":
            reading = self.sess.reading(ident)
            raw = reading.get("raw", {})
            size = _band(raw.get("insertions", 0) + raw.get("deletions", 0),
                         raw.get("filesChanged", 0))
            return (f"branch {ident}: {reading['display']} divergence, {explain(reading)}", size)
        detail = self.sess.commit_detail(sha)
        files = ", ".join(f["path"] for f in detail.get("files", [])[:8]) or "no files"
        lines = detail["insertions"] + detail["deletions"]
        text = (f"{detail['subject']} | +{detail['insertions']}/-{detail['deletions']} "
                f"in {detail['file_count']} file(s): {files}")
        return (text, _band(lines, detail["file_count"]))

    def _export(self) -> None:
        sess = self.sess
        body = self._body()
        snap = sess.snapshot()
        analyses = sess.store.list("oracle", limit=40) if body.get("includeAnalyses", True) else []
        # Everything the page needs to stand on its own, gathered here rather
        # than by the builder: summaries come from the store in one pass, and
        # links come from the forge, both of which belong to the session.
        summaries = {
            row["_key"]: row["summary"]
            for row in sess.store.list("explain", limit=20000) if row.get("summary")
        }
        page = export.build(snap, analyses, note=body.get("note"),
                            summaries=summaries, forge=sess.forge)

        out_dir = os.path.join(sess.repo.path, ".steinsgit", "exports")
        name = f"{snap['repo']['name']}-divergence-{time.strftime('%Y%m%d-%H%M%S')}.html"
        path = os.path.join(out_dir, name)
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(page)
        except OSError as exc:
            return self._error(f"could not write export: {exc}", 500)
        self._json({
            "ok": True, "path": path, "name": name,
            "bytes": len(page.encode("utf-8")),
            "url": f"/exports/{name}",
            "analyses": len(analyses),
        })

    def _create_worktree(self) -> None:
        body = self._body()
        a, b = body.get("a"), body.get("b")
        if not a or not b:
            return self._error("need both a and b")
        result = worktree.create(self.sess.repo, a, b, branch=body.get("branch"))
        if result.get("ok"):
            self.sess.record_worldline(result)
            self.sess.snapshot(force=True)  # the new branch is a new line
        self._json(result, 200 if result.get("ok") else 400)


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _band(lines: int, files: int) -> str:
    """How much room a summary gets, from how much actually changed."""
    if lines >= 120 or files >= 6:
        return "large"
    if lines < 30 and files <= 2:
        return "small"
    return "medium"
