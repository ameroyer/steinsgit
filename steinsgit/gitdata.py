"""Git porcelain access layer.

Everything here shells out to `git` and parses stable, machine-oriented
output (`-z`, `--format=`, `--numstat`). No writes to the repository ever
happen in this module; see `worktree.py` for the one mutating operation.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Iterable

# Field separator for `git log --format=`. \x1f is the ASCII unit separator,
# which cannot appear in any of the fields we request.
FS = "\x1f"
RS = "\x1e"

MAIN_CANDIDATES = ("main", "master", "trunk", "develop", "dev")


def git_env() -> dict:
    """Environment for every git child process, so output stays stable
    regardless of the user's config and no optional lock is ever taken."""
    return {**os.environ, "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0"}


class GitError(RuntimeError):
    pass


@dataclass
class Commit:
    sha: str
    short: str
    parents: list[str]
    author: str
    ts: int
    subject: str
    refs: list[str] = field(default_factory=list)
    # Was a model involved in writing this commit? See _authored_with_ai.
    ai: bool = False
    # Who the message credits as the model co-author, name only. Kept so the
    # marker can say whose work it is rather than leaving you to guess why a
    # commit with a person's name on it is lit up.
    ai_with: str = ""

    # Filled in by the layout pass.
    lane: int = 0
    y: float = 0.0
    branch: str | None = None
    impact: dict | None = None

    def to_json(self) -> dict:
        return {
            "sha": self.sha,
            "short": self.short,
            "parents": self.parents,
            "author": self.author,
            "ts": self.ts,
            "subject": self.subject,
            "refs": self.refs,
            "lane": self.lane,
            "y": round(self.y, 2),
            "branch": self.branch,
            "merge": len(self.parents) > 1,
            "ai": self.ai,
            "aiWith": self.ai_with,
            "impact": self.impact,
        }


@dataclass
class Ref:
    name: str          # short name, e.g. "feature/x" or "origin/feature/x"
    sha: str
    ts: int
    remote: bool
    is_head: bool


class Repo:
    """A thin, cached wrapper around one git repository."""

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        if not os.path.isdir(self.path):
            raise GitError(f"no such directory: {self.path}")
        try:
            top = self.run("rev-parse", "--show-toplevel")
        except (GitError, OSError) as exc:
            raise GitError(f"{self.path} is not a git repository ({exc})") from exc
        self.path = top.strip()
        self._diff_cache: dict[tuple, object] = {}
        # Whether this git has `merge-tree --write-tree` (2.38+). Probed on
        # first use, because most repositories never ask for a merge test.
        self._write_tree: bool | None = None

    # ---------------------------------------------------------------- plumbing

    def run(self, *args: str, check: bool = True, timeout: int = 60) -> str:
        proc = subprocess.run(
            ("git", *args),
            cwd=self.path,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=git_env(),
        )
        if check and proc.returncode != 0:
            raise GitError(proc.stderr.strip() or f"git {' '.join(args)} failed")
        return proc.stdout

    def run_ok(self, *args: str) -> tuple[bool, str]:
        """Run a command, returning (success, combined output) instead of raising."""
        proc = subprocess.run(
            ("git", *args),
            cwd=self.path,
            capture_output=True,
            text=True,
            timeout=120,
            env=git_env(),
        )
        return proc.returncode == 0, (proc.stdout + proc.stderr).strip()

    # ------------------------------------------------------------------- refs

    def head_branch(self) -> str | None:
        try:
            return self.run("symbolic-ref", "--short", "-q", "HEAD").strip() or None
        except GitError:
            return None  # detached HEAD

    def refs(self, include_remotes: bool = True) -> list[Ref]:
        head = self.head_branch()
        patterns = ["refs/heads"]
        if include_remotes:
            patterns.append("refs/remotes")
        out = self.run(
            "for-each-ref",
            f"--format=%(refname:short){FS}%(objectname){FS}%(committerdate:unix){FS}%(refname)",
            *patterns,
        )
        refs: list[Ref] = []
        for line in out.splitlines():
            if not line:
                continue
            name, sha, ts, full = line.split(FS)
            # origin/HEAD is a symbolic alias, not a real world line.
            if name.endswith("/HEAD"):
                continue
            refs.append(
                Ref(
                    name=name,
                    sha=sha,
                    ts=int(ts or 0),
                    remote=full.startswith("refs/remotes/"),
                    is_head=(name == head),
                )
            )
        return refs

    def main_branch(self, override: str | None = None) -> str:
        """Pick the reference world line: the branch everything is measured against."""
        names = {r.name for r in self.refs()}
        if override:
            if override not in names:
                raise GitError(f"branch {override!r} not found in this repository")
            return override
        # origin/HEAD points at the remote's default branch when it is set.
        try:
            sym = self.run("symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD").strip()
            if sym:
                local = sym.split("/", 1)[1]
                if local in names:
                    return local
                if sym in names:
                    return sym
        except GitError:
            pass
        for cand in MAIN_CANDIDATES:
            if cand in names:
                return cand
            if f"origin/{cand}" in names:
                return f"origin/{cand}"
        head = self.head_branch()
        if head:
            return head
        if names:
            return sorted(names)[0]
        raise GitError("repository has no branches")

    # --------------------------------------------------------------- history

    # %ae is deliberately absent: the author name attributes a commit and
    # the address is never needed, so it is never read. The co-author
    # trailer is read only to answer yes or no to "was a model involved" -
    # it is tested and dropped on the spot, never stored or sent anywhere.
    LOG_FMT = FS.join([
        "%H", "%h", "%P", "%an", "%ct", "%D",
        "%(trailers:key=Co-authored-by,valueonly,separator=%x2C)",
        "%s",
    ]) + RS

    def log(self, since_days: int | None = 90, max_commits: int = 2000) -> list[Commit]:
        """Load the commit DAG for every ref, newest first."""
        args = ["log", "--all", "--date-order", f"--format={self.LOG_FMT}",
                f"--max-count={max_commits}"]
        if since_days:
            args.append(f"--since={since_days}.days.ago")
        return self._parse_log(self.run(*args))

    def log_at(self, shas: list[str]) -> list[Commit]:
        """Just these commits, no ancestry walk. Used to pull a ref tip that
        fell outside the window back in without re-reading all of history."""
        if not shas:
            return []
        try:
            out = self.run("log", "--no-walk", f"--format={self.LOG_FMT}",
                           "--end-of-options", *shas)
        except GitError:
            return []
        return self._parse_log(out)

    def _parse_log(self, out: str) -> list[Commit]:
        commits: list[Commit] = []
        for record in out.split(RS):
            record = record.strip("\n")
            if not record:
                continue
            parts = record.split(FS)
            if len(parts) != 8:
                continue
            sha, short, parents, author, ts, decor, trailers, subject = parts
            commits.append(
                Commit(
                    sha=sha,
                    short=short,
                    parents=parents.split() if parents else [],
                    author=author,
                    ts=int(ts),
                    subject=subject,
                    refs=_parse_decoration(decor),
                    **_ai_credit(author, trailers),
                )
            )
        return commits

    def commit_stats(self, since_days: int | None, max_commits: int) -> dict[str, tuple]:
        """Per-commit (insertions, deletions, files) for the whole window.

        One `git log --numstat` pass for every commit at once. Doing this per
        commit would be thousands of subprocesses; this is one.
        """
        args = ["log", "--all", "--numstat", "--no-renames",
                f"--format={RS}%H", f"--max-count={max_commits}"]
        if since_days:
            args.append(f"--since={since_days}.days.ago")
        try:
            out = self.run(*args)
        except GitError:
            return {}

        stats: dict[str, tuple] = {}
        for block in out.split(RS):
            lines = block.strip("\n").split("\n")
            if not lines or not lines[0].strip():
                continue
            sha = lines[0].strip()
            ins = dels = files = 0
            for a, d, _ in numstat_lines(lines[1:]):
                ins += a
                dels += d
                files += 1
            stats[sha] = (ins, dels, files)
        return stats

    def commit_detail(self, sha: str) -> dict:
        fmt = FS.join(["%H", "%h", "%P", "%an", "%ct", "%cn", "%s", "%b"])
        out = self.run("show", "-s", f"--format={fmt}", sha)
        parts = out.split(FS)
        stat = self.run("show", "--numstat", "--format=", sha)
        files = []
        ins = dels = 0
        for a, d, name in numstat_lines(stat.splitlines()):
            ins += a
            dels += d
            files.append({"path": name, "insertions": a, "deletions": d})
        files.sort(key=lambda f: -(f["insertions"] + f["deletions"]))
        return {
            "sha": parts[0],
            "short": parts[1],
            "parents": parts[2].split() if parts[2] else [],
            "author": parts[3],
            "ts": int(parts[4]),
            "committer": parts[5],
            "subject": parts[6],
            "body": parts[7] if len(parts) > 7 else "",
            "insertions": ins,
            "deletions": dels,
            "files": files[:60],
            "file_count": len(files),
        }

    # ------------------------------------------------------------- comparison

    def rev_parse(self, ref: str) -> str | None:
        """Resolve a ref to a commit SHA. Cache keys are built from these."""
        try:
            return self.run("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").strip() or None
        except GitError:
            return None

    # `--end-of-options` before every caller-supplied ref: a ref named like an
    # option must be read as a ref, never parsed as a flag.
    def merge_base(self, a: str, b: str) -> str | None:
        try:
            return self.run("merge-base", "--end-of-options", a, b).strip() or None
        except GitError:
            return None  # unrelated histories

    def ahead_behind(self, base: str, head: str) -> tuple[int, int]:
        """(ahead, behind) of `head` relative to `base`."""
        try:
            out = self.run("rev-list", "--left-right", "--count",
                           "--end-of-options", f"{base}...{head}").split()
            return int(out[1]), int(out[0])
        except (GitError, IndexError, ValueError):
            return 0, 0

    def numstat(self, rev_range: str) -> tuple[int, int, set[str]]:
        """(insertions, deletions, touched paths) for a diff range."""
        key = ("numstat", rev_range)
        if key in self._diff_cache:
            return self._diff_cache[key]  # type: ignore[return-value]
        try:
            out = self.run("diff", "--numstat", "-M", "--end-of-options", rev_range)
        except GitError:
            out = ""
        ins = dels = 0
        paths: set[str] = set()
        for a, d, name in numstat_lines(out.splitlines()):
            ins += a
            dels += d
            paths.add(_unrename(name))
        result = (ins, dels, paths)
        self._diff_cache[key] = result
        return result

    def commit_ts(self, rev: str) -> int:
        try:
            return int(self.run("show", "-s", "--format=%ct", rev).strip())
        except (GitError, ValueError):
            return 0

    def branch_log(self, base: str | None, head: str, limit: int = 40) -> list[dict]:
        """Commits unique to `head` (or just its history when `base` is None),
        each with its own diff stats.

        `--numstat` is requested in the same pass, so this stays one process
        no matter how many commits come back.
        """
        fmt = FS.join(["%H", "%h", "%an", "%ct", "%s"])
        try:
            out = self.run(
                "log", "--numstat", "--no-renames", f"--format={RS}{fmt}",
                f"--max-count={limit}", "--end-of-options",
                f"{base}..{head}" if base else head,
            )
        except GitError:
            return []

        rows = []
        for block in out.split(RS):
            lines = block.strip("\n").split("\n")
            if not lines or FS not in lines[0]:
                continue
            parts = lines[0].split(FS)
            if len(parts) != 5:
                continue
            ins = dels = files = 0
            for a, d, _ in numstat_lines(lines[1:]):
                ins += a
                dels += d
                files += 1
            rows.append({
                "sha": parts[0], "short": parts[1], "author": parts[2],
                "ts": int(parts[3]), "subject": parts[4],
                "insertions": ins, "deletions": dels, "files": files,
            })
        return rows

    def merge_tree(self, a: str, b: str) -> dict:
        """Perform a real merge without touching the index or the worktree.

        `git merge-tree --write-tree` exits 0 on a clean merge and 1 when there
        are conflicts, so this gives us ground truth without guessing. It
        arrived in git 2.38; on anything older the same three words mean the
        old three-argument command and git answers with a usage message, so we
        fall back to merging the files ourselves.
        """
        if not self.supports_merge_tree():
            return self._merge_by_hand(a, b)

        proc = subprocess.run(
            ("git", "merge-tree", "--write-tree", "--name-only", "--messages", a, b),
            cwd=self.path,
            capture_output=True,
            text=True,
            timeout=120,
            env=git_env(),
        )
        stdout = proc.stdout
        if proc.returncode not in (0, 1):
            return {
                "ok": False,
                "clean": False,
                "error": (proc.stderr.strip() or "merge-tree failed"),
                "conflicts": [],
                "messages": "",
            }
        # Without -z the output is line based:
        #   <tree oid>
        #   <conflicted path>...        (absent on a clean merge)
        #   <blank line>
        #   <informational messages>    (only with --messages)
        lines = stdout.split("\n")
        tree = lines[0].strip() if lines else ""
        conflicts: list[str] = []
        idx = 1
        while idx < len(lines) and lines[idx].strip():
            conflicts.append(lines[idx].strip())
            idx += 1
        messages = "\n".join(lines[idx + 1:]).strip()

        return {
            "ok": True,
            "clean": proc.returncode == 0 and not conflicts,
            "tree": tree,
            "conflicts": conflicts,
            "messages": messages,
            "error": None,
            "engine": "merge-tree",
        }

    # ------------------------------------------------------- old git fallback

    def supports_merge_tree(self) -> bool:
        """Does this git know `merge-tree --write-tree` (2.38+)? Asked once."""
        if self._write_tree is None:
            proc = subprocess.run(
                ("git", "merge-tree", "--write-tree", "-h"),
                cwd=self.path, capture_output=True, text=True, timeout=20,
                env=git_env(),
            )
            blurb = (proc.stdout + proc.stderr)
            self._write_tree = "--write-tree" in blurb
        return self._write_tree

    def _merge_by_hand(self, a: str, b: str) -> dict:
        """A real three-way merge on a scratch index, for git older than 2.38.

        `read-tree -m --aggressive` resolves everything trivially resolvable and
        leaves the rest unmerged - but "both sides touched this file" is not the
        same as "this file conflicts", so every survivor is then merged for real
        with `git merge-file`, which is the same three-way text merge git itself
        would run. The answer is still a merge that happened, not a guess.

        What it cannot do is detect renames, so a file moved on one side and
        edited on the other is reported as a conflict where git 2.38 would have
        merged it. That is the safe direction to be wrong in, and it is named in
        the result so nothing downstream has to pretend otherwise.
        """
        base = self.merge_base(a, b)
        if not base:
            return {"ok": False, "clean": False, "conflicts": [], "messages": "",
                    "error": f"{a} and {b} share no history", "engine": "merge-file"}

        # A scratch index in its own directory. It has to be a path git can
        # create, not an existing empty file - git reads a zero-byte index as a
        # truncated one and refuses to go on.
        scratch = tempfile.mkdtemp(prefix="steinsgit-merge-")
        env = {**git_env(), "GIT_INDEX_FILE": os.path.join(scratch, "index")}
        try:
            read = subprocess.run(
                ("git", "read-tree", "-m", "--aggressive", base, a, b),
                cwd=self.path, capture_output=True, text=True, timeout=120, env=env,
            )
            if read.returncode != 0:
                return {"ok": False, "clean": False, "conflicts": [], "messages": "",
                        "error": (read.stderr.strip() or "read-tree failed"),
                        "engine": "merge-file"}
            listing = subprocess.run(
                ("git", "ls-files", "-u", "-z"),
                cwd=self.path, capture_output=True, text=True, timeout=60, env=env,
            ).stdout

            # `ls-files -u` prints one line per stage: 1 is the base, 2 ours,
            # 3 theirs. Collect them per path before deciding anything.
            stages: dict[str, dict[int, str]] = {}
            for entry in listing.split("\0"):
                if not entry:
                    continue
                meta, _, path = entry.partition("\t")
                bits = meta.split()
                if len(bits) < 3:
                    continue
                stages.setdefault(path, {})[int(bits[2])] = bits[1]
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

        conflicts, notes = [], []
        for path, stage in sorted(stages.items()):
            ours, theirs = stage.get(2), stage.get(3)
            if not ours or not theirs:
                # One side deleted what the other kept or changed. git cannot
                # decide that for you and neither can we.
                conflicts.append(path)
                notes.append(f"CONFLICT (modify/delete): {path}")
                continue
            if ours == theirs:
                continue                      # same content, nothing to settle
            if not self._merges_cleanly(stage.get(1), ours, theirs):
                conflicts.append(path)
                notes.append(f"CONFLICT (content): Merge conflict in {path}")

        return {
            "ok": True,
            "clean": not conflicts,
            "tree": None,
            "conflicts": conflicts,
            "messages": "\n".join(notes),
            "error": None,
            # Named so callers can say which engine answered, and warn that
            # renames are invisible to this one.
            "engine": "merge-file",
        }

    def _merges_cleanly(self, base: str | None, ours: str, theirs: str) -> bool:
        """Three-way merge three blobs. True when git can settle it alone."""
        paths = []
        try:
            for oid in (ours, base, theirs):
                fh = tempfile.NamedTemporaryFile(prefix="steinsgit-blob-", delete=False)
                if oid:
                    fh.write(self._blob(oid))
                fh.close()
                paths.append(fh.name)
            done = subprocess.run(
                ("git", "merge-file", "-q", "-p", *paths),
                cwd=self.path, capture_output=True, timeout=60,
                env=git_env(),
            )
            # 0 clean, >0 is the number of conflict hunks, <0 is a real error.
            # A binary file git refuses to merge comes back as an error, which
            # is a conflict as far as anyone merging is concerned.
            return done.returncode == 0
        finally:
            for name in paths:
                try:
                    os.unlink(name)
                except OSError:
                    pass

    def _blob(self, oid: str) -> bytes:
        return subprocess.run(
            ("git", "cat-file", "blob", oid),
            cwd=self.path, capture_output=True, timeout=60,
            env=git_env(),
        ).stdout


# The conventional way a tool records that it helped write a commit is a
# co-author trailer, which is what every Claude Code commit carries. Matching
# the author name as well catches a commit made under the model's own name.
_AI_MARK = re.compile(r"claude|anthropic|copilot|gpt-|codex|gemini", re.I)


def _ai_credit(author: str, trailers: str) -> dict:
    """Whether a model is credited, and under what name.

    A commit is nearly always written by a person who credits the model as a
    co-author, so the author's own name says nothing about it - which is why
    the name that matched is worth carrying. Addresses are stripped here and
    never leave this function, so the promise about author emails still holds.
    """
    for candidate in _split_trailers(trailers) + [author]:
        if _AI_MARK.search(candidate):
            return {"ai": True, "ai_with": _name_only(candidate)}
    return {"ai": False, "ai_with": ""}


def _split_trailers(trailers: str) -> list[str]:
    """One entry per co-author. Commas separate them, newlines repeat them."""
    if not trailers:
        return []
    parts = []
    for line in trailers.splitlines():
        parts.extend(piece.strip() for piece in line.split(","))
    return [p for p in parts if p]


def _name_only(credit: str) -> str:
    """'Claude Opus 5 <noreply@example>' -> 'Claude Opus 5'."""
    return re.sub(r"<[^>]*>", "", credit).strip(" \t<>")


def numstat_lines(lines) -> Iterable[tuple[int, int, str]]:
    """Parse `--numstat` lines into (insertions, deletions, path).

    "-" marks a binary file: it counts as a touched file but contributes no
    line count.
    """
    for line in lines:
        bits = line.split("\t")
        if len(bits) != 3:
            continue
        a, d, name = bits
        yield (0 if a == "-" else int(a), 0 if d == "-" else int(d), name)


def _unrename(path: str) -> str:
    """`git diff -M` renders renames as `a/{old => new}/c`; keep the new path."""
    if "=>" not in path:
        return path
    m = re.match(r"^(.*)\{(.*) => (.*)\}(.*)$", path)
    if m:
        return f"{m.group(1)}{m.group(3)}{m.group(4)}".replace("//", "/")
    return path.split("=>")[-1].strip()


def _parse_decoration(decor: str) -> list[str]:
    refs = []
    for part in decor.split(", "):
        part = part.strip()
        if not part:
            continue
        if part.startswith("HEAD -> "):
            refs.append(part[len("HEAD -> "):])
            refs.append("HEAD")
        else:
            refs.append(part)
    return refs


def parallel_map(fn, items: Iterable, workers: int = 16) -> list:
    """git subprocesses are I/O bound, so threads are the right tool here.

    A repository with hundreds of branches needs several git calls each, so the
    pool is sized past the core count: these threads spend their time waiting
    on a child process, not computing.
    """
    items = list(items)
    if not items:
        return []
    if len(items) == 1:
        return [fn(items[0])]
    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        return list(pool.map(fn, items))
