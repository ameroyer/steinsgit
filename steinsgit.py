#!/usr/bin/env python3
"""steinsgit - a git world-line viewer with a Divergence Meter.

    ./steinsgit.py [repo] [--days 90] [--port 8787]

No dependencies beyond Python 3.9, git, and (optionally) the `claude` CLI.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from steinsgit import oracle  # noqa: E402
from steinsgit.gitdata import GitError  # noqa: E402
from steinsgit.server import serve  # noqa: E402
from steinsgit.session import Session  # noqa: E402

BANNER = r"""
   ____  _____ _____ ___ _   _ ____   ___ ____ ___ _____
  / ___||_   _| ____|_ _| \ | / ___| / _ \  _ \_ _|_   _|
  \___ \  | | |  _|  | ||  \| \___ \| | | | |_) | |  | |
   ___) | | | | |___ | || |\  |___) | |_| |  __/| |  | |
  |____/  |_| |_____|___|_| \_|____/ \___/|_|  |___| |_|
           b r a n c h   d i v e r g e n c e
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="steinsgit",
        description="Visualise how far each git branch has diverged from the default branch.",
    )
    parser.add_argument("repo", nargs="?", default=".", help="path to the repository (default: .)")
    parser.add_argument("--days", type=int, default=90,
                        help="how far back to read history, in days (0 = all)")
    parser.add_argument("--max-commits", type=int, default=2000,
                        help="hard cap on commits loaded")
    parser.add_argument("--main", default=None,
                        help="branch to measure divergence from (auto-detected)")
    parser.add_argument("--model", default="sonnet",
                        help="model used for analysis (sonnet, opus, haiku, ...)")
    parser.add_argument("--explain-model", default="haiku",
                        help="model used for bulk commit/branch explanations")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-remotes", action="store_true",
                        help="ignore remote-tracking branches")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    parser.add_argument("--no-cache", action="store_true",
                        help="do not read or write the knowledge base")
    parser.add_argument("--forget", action="store_true",
                        help="clear the knowledge base before starting")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every request")
    args = parser.parse_args(argv)

    try:
        session = Session(
            path=args.repo,
            days=args.days or None,
            max_commits=args.max_commits,
            main=args.main,
            model=args.model,
            explain_model=args.explain_model,
            include_remotes=not args.no_remotes,
            cache=not args.no_cache,
        )
        if args.forget:
            session.store.clear()
    except GitError as exc:
        print(f"steinsgit: {exc}", file=sys.stderr)
        return 2

    print(BANNER)
    print(f"  reading {session.repo.path} ...")
    try:
        snap = session.snapshot()
    except GitError as exc:
        print(f"steinsgit: {exc}", file=sys.stderr)
        return 2

    meta = snap["repo"]
    print(f"  default branch : {meta['main']}")
    print(f"  branches       : {meta['branchCount']}")
    print(f"  commits        : {meta['commitCount']}  (scan {meta['scanMs']} ms)")
    print(f"  claude         : {'ready (' + args.model + ')' if oracle.available() else 'unavailable - claude CLI not on PATH'}")
    know = meta.get("cache") or {}
    if know.get("enabled"):
        rows = sum(k["rows"] for k in know.get("kinds", {}).values())
        print(f"  saved data     : {rows} entries, {know.get('bytes', 0) // 1024} KB"
              f"{'  (reused, nothing changed)' if meta.get('fromCache') else ''}")
    else:
        print("  saved data     : disabled")

    try:
        httpd = serve(session, host=args.host, port=args.port, verbose=args.verbose)
    except OSError as exc:
        print(f"steinsgit: cannot bind {args.host}:{args.port} ({exc})", file=sys.stderr)
        return 2

    url = f"http://{args.host}:{args.port}/"
    print(f"\n  >> {url}\n")
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped. el psy congroo.")
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
