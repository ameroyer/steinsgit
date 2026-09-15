"""Infer web links for the repository's remote host.

Given `git remote get-url origin`, work out whether this is GitHub, GitLab or
Bitbucket and build deep links: a commit, a single file inside that commit's
diff, a branch, and a branch comparison.

The per-file anchors are the fiddly part and differ per host:
  GitHub  #diff-<sha256(path)>
  GitLab  #<sha1(path)>
Bitbucket has no stable per-file anchor, so those links point at the commit.
"""

from __future__ import annotations

import hashlib
import re
from urllib.parse import quote

from .gitdata import GitError, Repo

KNOWN = ("github", "gitlab", "bitbucket")


def redact(url: str) -> str:
    """Hide any credentials embedded in a remote URL.

    `https://user:token@host/owner/repo` is a perfectly ordinary remote, and
    that token must never reach the browser, an export, or a log line.
    """
    if not url:
        return ""
    return re.sub(r"(?<=://)[^/@]+@", "", url)


def parse_remote(url: str) -> dict | None:
    """Normalise any git remote URL into {host, owner, repo, base}."""
    if not url:
        return None
    url = url.strip()
    if url.endswith(".git"):
        url = url[:-4]

    # A scheme means a normal URL; without one it can only be scp-style, so
    # check for "://" first or "https" gets mistaken for a hostname.
    if "://" in url:
        m = re.match(
            r"^[a-zA-Z][\w+.-]*://(?:[^/@]+@)?([\w.-]+)(?::\d+)?/(.+)$", url)
        if not m:
            return None
        host, path = m.group(1), m.group(2)
    else:
        m = re.match(r"^(?:[\w.-]+@)?([\w.-]+):(?!\d+(?:/|$))(.+)$", url)
        if not m:
            return None
        host, path = m.group(1), m.group(2)

    path = path.strip("/")
    if "/" not in path:
        return None
    owner, _, repo = path.rpartition("/")
    return {
        "host": host,
        "owner": owner,
        "repo": repo,
        "base": f"https://{host}/{path}",
        "path": path,
    }


def detect_kind(host: str) -> str:
    low = (host or "").lower()
    for name in KNOWN:
        if name in low:
            return name
    return "unknown"


class Forge:
    """Builds links, or reports that it cannot."""

    def __init__(self, repo: Repo, override: str = "auto", remote: str = "origin"):
        self.kind = "none"
        try:
            url = repo.run("remote", "get-url", remote).strip()
        except GitError:
            url = ""
        self.url = url
        self.info = parse_remote(url)
        if self.info:
            # An explicit choice wins: self-hosted GitLab rarely says "gitlab"
            # in its hostname.
            detected = detect_kind(self.info["host"])
            self.kind = detected if override in ("auto", "", None) else override
        self.override = override

    @property
    def available(self) -> bool:
        return bool(self.info) and self.kind in KNOWN

    def to_json(self) -> dict:
        return {
            "available": self.available,
            "kind": self.kind,
            "override": self.override,
            "host": self.info["host"] if self.info else None,
            "project": self.info["path"] if self.info else None,
            "base": self.info["base"] if self.info else None,
            "remoteUrl": redact(self.url),
            "detected": detect_kind(self.info["host"]) if self.info else "none",
        }

    # ------------------------------------------------------------------ links

    def commit(self, sha: str) -> str | None:
        if not self.available:
            return None
        base = self.info["base"]
        if self.kind == "gitlab":
            return f"{base}/-/commit/{sha}"
        if self.kind == "bitbucket":
            return f"{base}/commits/{sha}"
        return f"{base}/commit/{sha}"

    def file_in_commit(self, sha: str, path: str) -> str | None:
        """Deep link to one file inside a commit's diff view."""
        url = self.commit(sha)
        if not url:
            return None
        if self.kind == "github":
            anchor = hashlib.sha256(path.encode("utf-8")).hexdigest()
            return f"{url}#diff-{anchor}"
        if self.kind == "gitlab":
            anchor = hashlib.sha1(path.encode("utf-8")).hexdigest()
            return f"{url}#{anchor}"
        return url   # bitbucket has no stable per-file anchor

    def blob(self, sha: str, path: str) -> str | None:
        if not self.available:
            return None
        base = self.info["base"]
        safe = quote(path)
        if self.kind == "gitlab":
            return f"{base}/-/blob/{sha}/{safe}"
        if self.kind == "bitbucket":
            return f"{base}/src/{sha}/{safe}"
        return f"{base}/blob/{sha}/{safe}"

    def branch(self, name: str) -> str | None:
        if not self.available:
            return None
        base = self.info["base"]
        safe = quote(_strip_remote(name), safe="/")
        if self.kind == "gitlab":
            return f"{base}/-/tree/{safe}"
        if self.kind == "bitbucket":
            return f"{base}/branch/{safe}"
        return f"{base}/tree/{safe}"

    def compare(self, base_branch: str, head: str) -> str | None:
        if not self.available:
            return None
        base = self.info["base"]
        a, b = quote(_strip_remote(base_branch), safe="/"), quote(_strip_remote(head), safe="/")
        if self.kind == "gitlab":
            return f"{base}/-/compare/{a}...{b}"
        if self.kind == "bitbucket":
            return f"{base}/branches/compare/{b}%0D{a}"
        return f"{base}/compare/{a}...{b}"


def _strip_remote(name: str) -> str:
    for prefix in ("origin/", "upstream/"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name
