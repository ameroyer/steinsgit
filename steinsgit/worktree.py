"""The one mutating operation: fork a new world line into a git worktree.

This never touches the current checkout. It creates a fresh branch in a
separate worktree under `.steinsgit/worldlines/` and attempts the merge there,
leaving any conflicts in place for the user to resolve by hand.
"""

from __future__ import annotations

import os
import re
import subprocess

from .gitdata import GitError, Repo, numstat_lines

WORKTREE_ROOT = ".steinsgit/worldlines"


def _slug(name: str, limit: int = 24) -> str:
    """Short, filesystem-safe piece of a ref name.

    Forking a fork must not compound: `worldline/a--b` contributes `a--b`, not
    the whole previous name, or names grow without bound.
    """
    if name.startswith("worldline/"):
        name = name[len("worldline/"):]
    # The distinguishing part of `experiment/time-leap-machine` is the last
    # path segment, so keep that whole and shorten from its end if needed.
    name = name.rstrip("/").split("/")[-1] or name
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", name).strip("-").lower() or "line"
    if len(slug) > limit:
        slug = slug[:limit].rstrip("-")
    return slug or "line"


def ensure_excluded(repo: Repo) -> None:
    """Keep our scratch directory out of `git status` without editing .gitignore."""
    try:
        git_dir = repo.run("rev-parse", "--git-common-dir").strip()
    except GitError:
        return
    if not os.path.isabs(git_dir):
        git_dir = os.path.join(repo.path, git_dir)
    info = os.path.join(git_dir, "info")
    exclude = os.path.join(info, "exclude")
    try:
        os.makedirs(info, exist_ok=True)
        existing = ""
        if os.path.exists(exclude):
            with open(exclude, "r", encoding="utf-8") as fh:
                existing = fh.read()
        if ".steinsgit/" not in existing:
            with open(exclude, "a", encoding="utf-8") as fh:
                fh.write("\n# steinsgit scratch worktrees\n.steinsgit/\n")
    except OSError:
        pass  # cosmetic only


def _free_branch_name(repo: Repo, wanted: str) -> str:
    existing = {r.name for r in repo.refs(include_remotes=False)}
    if wanted not in existing:
        return wanted
    n = 2
    while f"{wanted}-{n}" in existing:
        n += 1
    return f"{wanted}-{n}"


def create(repo: Repo, base: str, incoming: str, branch: str | None = None) -> dict:
    """Branch from `base` in a new worktree, then merge `incoming` into it."""
    for ref in (base, incoming):
        ok, _ = repo.run_ok("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
        if not ok:
            return {"ok": False, "error": f"unknown ref: {ref}"}
    # The generated names are safe by construction; a caller-chosen one is
    # checked so nothing option-shaped or otherwise illegal reaches git.
    if branch:
        ok, _ = repo.run_ok("check-ref-format", "--branch", branch)
        if not ok or branch.startswith("-"):
            return {"ok": False, "error": f"not a legal branch name: {branch}"}

    ensure_excluded(repo)

    wanted = branch or f"worldline/{_slug(base)}--{_slug(incoming)}"
    name = _free_branch_name(repo, wanted)
    rel = os.path.join(WORKTREE_ROOT, _slug(name.split("/")[-1]))
    path = os.path.join(repo.path, rel)
    if os.path.exists(path):
        n = 2
        while os.path.exists(f"{path}-{n}"):
            n += 1
        path = f"{path}-{n}"

    ok, out = repo.run_ok("worktree", "add", "-b", name, path, base)
    if not ok:
        return {"ok": False, "error": f"git worktree add failed: {out}"}

    merge = subprocess.run(
        ("git", "merge", "--no-ff", "--no-edit", "--end-of-options", incoming),
        cwd=path,
        capture_output=True,
        text=True,
        timeout=300,
        env={**os.environ, "LC_ALL": "C"},
    )
    clean = merge.returncode == 0

    def _git(*args: str) -> str:
        return subprocess.run(
            ("git",) + args, cwd=path, capture_output=True, text=True,
            env={**os.environ, "LC_ALL": "C"},
        ).stdout

    conflicts: list[dict] = []
    changed: list[dict] = []
    commit_sha = None

    if clean:
        commit_sha = _git("rev-parse", "--short", "HEAD").strip()
        for a, d, name in numstat_lines(_git("diff", "--numstat", "HEAD^1", "HEAD").splitlines()):
            changed.append({"path": name, "insertions": a, "deletions": d})
        changed.sort(key=lambda f: -(f["insertions"] + f["deletions"]))
    else:
        names = [ln for ln in _git("diff", "--name-only", "--diff-filter=U").splitlines() if ln.strip()]
        conflicts = _conflict_detail(path, names)

    return {
        "ok": True,
        "clean": clean,
        "branch": name,
        "base": base,
        "incoming": incoming,
        "path": path,
        "relPath": os.path.relpath(path, repo.path),
        "commit": commit_sha,
        "conflicts": conflicts,
        "changed": changed[:40],
        "changedCount": len(changed),
        "output": (merge.stdout + merge.stderr).strip()[:4000],
        "nextSteps": (
            [f"cd {path}", "Review the merge, then run your tests."]
            if clean else
            [
                f"cd {path}",
                f"Fix the {len(conflicts)} file(s) marked below.",
                "Run: git add <file> for each file you fixed.",
                "Run: git commit to finish the merge.",
            ]
        ),
    }


def _conflict_detail(path: str, names: list[str]) -> list[dict]:
    """Conflict-marker counts per file, worst first."""
    detail = []
    for fname in names:
        markers = 0
        try:
            with open(os.path.join(path, fname), "r", encoding="utf-8", errors="replace") as fh:
                markers = sum(1 for ln in fh if ln.startswith("<<<<<<<"))
        except OSError:
            pass
        detail.append({"path": fname, "hunks": markers})
    detail.sort(key=lambda f: -f["hunks"])
    return detail


def recover_provenance(repo: Repo, branch: str) -> dict | None:
    """Work out what an existing merge-test branch was made from.

    Branches created before provenance was recorded, and any merge stopped by a
    conflict, have no merge commit to read parents from. An unfinished merge
    still keeps MERGE_HEAD and MERGE_MSG in its worktree, which name the
    incoming side exactly; the base is whichever branch the worktree HEAD sits
    on. Falls back to matching the slugs in the branch name.
    """
    path = None
    for entry in listing(repo):
        if entry.get("branch") == branch:
            path = entry.get("path")
            break

    incoming = base = None
    if path and os.path.isdir(path):
        def _git(*args):
            proc = subprocess.run(("git",) + args, cwd=path, capture_output=True,
                                  text=True, env={**os.environ, "LC_ALL": "C"})
            return proc.stdout.strip() if proc.returncode == 0 else ""

        git_dir = _git("rev-parse", "--git-dir")
        if git_dir:
            if not os.path.isabs(git_dir):
                git_dir = os.path.join(path, git_dir)
            try:
                with open(os.path.join(git_dir, "MERGE_MSG"), encoding="utf-8") as fh:
                    m = re.match(r"Merge branch '([^']+)'", fh.readline())
                    if m:
                        incoming = m.group(1)
            except OSError:
                pass

        head = _git("rev-parse", "HEAD")
        merge_head = _git("rev-parse", "MERGE_HEAD")
        tips = {r.sha: r.name for r in repo.refs(include_remotes=False)
                if not r.name.startswith("worldline/")}
        base = tips.get(head)
        if not incoming:
            incoming = tips.get(merge_head)

    if not (base and incoming):
        # Last resort: the name is `worldline/<base>--<incoming>`, slugged.
        body = branch[len("worldline/"):] if branch.startswith("worldline/") else branch
        if "--" in body:
            want_base, _, want_in = body.partition("--")
            for ref in repo.refs(include_remotes=False):
                if ref.name.startswith("worldline/"):
                    continue
                if not base and _slug(ref.name) == want_base:
                    base = ref.name
                if not incoming and _slug(ref.name) == want_in:
                    incoming = ref.name

    if not (base or incoming):
        return None
    return {"base": base, "incoming": incoming, "path": path, "recovered": True}


def status(repo: Repo, branch: str, path: str | None = None) -> dict | None:
    """Current state of a merge-test worktree: what is still unresolved.

    Read live from the worktree rather than from what we recorded at creation,
    because the user may have fixed some of it by hand since.
    """
    if not path:
        for entry in listing(repo):
            if entry.get("branch") == branch:
                path = entry.get("path")
                break
    if not path or not os.path.isdir(path):
        return None

    def _git(*args: str) -> tuple[bool, str]:
        proc = subprocess.run(
            ("git",) + args, cwd=path, capture_output=True, text=True,
            env={**os.environ, "LC_ALL": "C"},
        )
        return proc.returncode == 0, proc.stdout

    ok, unresolved = _git("diff", "--name-only", "--diff-filter=U")
    files = [ln for ln in unresolved.splitlines() if ln.strip()] if ok else []
    detail = _conflict_detail(path, files)

    _, staged = _git("diff", "--name-only", "--cached")
    _, merging = _git("rev-parse", "--verify", "--quiet", "MERGE_HEAD")
    return {
        "path": path,
        "unresolved": detail,
        "unresolvedCount": len(detail),
        "staged": len([ln for ln in staged.splitlines() if ln.strip()]),
        "mergeInProgress": bool(merging.strip()),
        "hunks": sum(f["hunks"] for f in detail),
    }


def find_existing(repo: Repo, base: str, incoming: str,
                  records: dict | None = None) -> list[dict]:
    """Worldline branches already made from this same pair.

    Matching is by recorded provenance where available, because branch names
    are slugged and truncated and so cannot be reversed reliably. Creating a
    second one is legal, but doing it by accident is not what anybody wants.
    """
    wanted = f"worldline/{_slug(base)}--{_slug(incoming)}"
    records = records or {}
    trees = {w.get("branch"): w for w in listing(repo)}
    out = []
    for ref in repo.refs(include_remotes=False):
        rec = records.get(ref.name) or {}
        by_record = rec.get("base") == base and rec.get("incoming") == incoming
        by_name = ref.name == wanted or ref.name.startswith(wanted + "-")
        if not (by_record or by_name):
            continue
        tree = trees.get(ref.name)
        entry = {
            "branch": ref.name,
            "sha": ref.sha[:10],
            "ts": ref.ts,
            "path": (tree or {}).get("path") or rec.get("path"),
            "clean": rec.get("clean"),
        }
        if tree and tree.get("path"):
            ok, out_txt = repo.run_ok("-C", tree["path"], "diff", "--name-only", "--diff-filter=U")
            entry["unresolved"] = [ln for ln in out_txt.splitlines() if ln.strip()] if ok else []
        out.append(entry)
    return out


def listing(repo: Repo) -> list[dict]:
    ok, out = repo.run_ok("worktree", "list", "--porcelain")
    if not ok:
        return []
    entries: list[dict] = []
    current: dict = {}
    for line in out.splitlines():
        if not line.strip():
            if current:
                entries.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = {"path": value}
        elif key == "branch":
            current["branch"] = value.replace("refs/heads/", "")
        elif key == "HEAD":
            current["head"] = value[:10]
    if current:
        entries.append(current)
    return [e for e in entries if WORKTREE_ROOT.replace("/", os.sep) in e.get("path", "")]
