#!/usr/bin/env python3
"""steinsgit - a git world-line viewer with a Divergence Meter.

    ./steinsgit.py [repo] [--days 90] [--port 8787]

A shim for running the tool straight out of a checkout, without installing it.
The command itself lives in `steinsgit/cli.py`, which is also what the
installed `steinsgit` console script and `python -m steinsgit` call.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from steinsgit.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
