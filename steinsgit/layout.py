"""World-line layout.

Time flows bottom to top: the root of history sits at the bottom of the canvas
and the newest commits are the leaves at the top. The reference branch is a
dead-straight vertical spine in the centre column, and every other branch is a
straight vertical line packed into a free column to its left or right, so the
picture reads as timelines growing upward and splitting away from one trunk.

Three passes:
  1. ownership - which branch each commit belongs to (first-parent walk)
  2. y         - topological order + log-compressed time spacing
  3. columns   - interval-pack branches into columns, alternating left/right

World coordinates: y is negative going up, so the oldest commit sits at y=0 and
the newest at the most negative y. The renderer maps world y straight to screen
y, which puts the root at the bottom without any extra flipping.
"""

from __future__ import annotations

import math
from collections import deque

from .divergence import commit_impact, scale_rel
from .gitdata import Commit, Ref

MIN_DY = 38.0      # minimum gap between a parent and its child
MAX_DY = 170.0     # cap so a six-month gap does not become a desert
STRETCH = 30.0     # how strongly real elapsed time stretches the timeline
LANE_PAD = 70.0    # clearance below a branch before another may share its column
LABEL_PAD = 320.0  # clearance above a branch tip, where its name plate is drawn


def build(commits: list[Commit], refs: list[Ref], main: str,
          stats: dict[str, tuple] | None = None,
          divergences: dict[str, float] | None = None) -> dict:
    index = {c.sha: c for c in commits}
    if not index:
        return {"commits": [], "edges": [], "branches": [], "bounds": {}}

    live_refs = [r for r in refs if r.sha in index]
    owner = _assign_ownership(index, live_refs, main)
    _compute_y(commits, index)
    branches = _pack_columns(index, live_refs, main, owner, divergences or {})
    col_of = {b["name"]: b["lane"] for b in branches}

    for c in commits:
        c.branch = owner.get(c.sha)
        c.lane = col_of.get(c.branch or "", 0)

    _attach_impact(commits, stats or {})

    edges = _build_edges(commits, index)
    ys = [c.y for c in commits]
    return {
        "commits": [c.to_json() for c in commits],
        "edges": edges,
        "branches": branches,
        "bounds": {
            "minY": min(ys), "maxY": max(ys),
            "minTs": min(c.ts for c in commits), "maxTs": max(c.ts for c in commits),
            # The closest two commits can ever be on the time axis. The
            # renderer turns this into a floor on the vertical scale, so it
            # can never zoom out far enough to stack one dot on another.
            "minDy": MIN_DY,
        },
    }


# --------------------------------------------------------------------- pass 1

def _assign_ownership(index: dict[str, Commit], refs: list[Ref], main: str) -> dict[str, str]:
    """Walk each branch's first-parent spine and claim unclaimed commits.

    Priority matters: the reference branch claims its trunk first so that main
    is never visually hijacked by a branch that happens to share commits.
    """
    order = sorted(refs, key=lambda r: (r.name != main, r.remote, -r.ts, r.name))
    owner: dict[str, str] = {}

    for ref in order:
        sha = ref.sha
        while sha and sha in index and sha not in owner:
            owner[sha] = ref.name
            parents = index[sha].parents
            sha = parents[0] if parents else None

    # Anything reachable only through a merge's second parent (a branch whose
    # own ref is gone) still needs a home.
    remaining = [s for s in index if s not in owner]
    if remaining:
        for ref in order:
            if not remaining:
                break
            queue = deque([ref.sha])
            seen = set()
            while queue:
                sha = queue.popleft()
                if sha in seen or sha not in index:
                    continue
                seen.add(sha)
                if sha not in owner:
                    owner[sha] = ref.name
                queue.extend(index[sha].parents)
        remaining = [s for s in index if s not in owner]
    for sha in remaining:
        owner[sha] = main
    return owner


# --------------------------------------------------------------------- pass 2

def _compute_y(commits: list[Commit], index: dict[str, Commit]) -> None:
    """Position commits along the time axis, then repair topological order.

    Elapsed time is compressed logarithmically: a burst of ten commits in an
    hour stays readable, and a three-month lull becomes a visible gap rather
    than a kilometre of empty canvas.
    """
    by_time = sorted(commits, key=lambda c: (c.ts, c.sha))
    base: dict[str, float] = {}
    cursor = 0.0
    prev_ts = by_time[0].ts
    for c in by_time:
        dt = max(0, c.ts - prev_ts)
        step = MIN_DY + STRETCH * math.log1p(dt / 3600.0)
        cursor += min(step, MAX_DY) if base else 0.0
        base[c.sha] = cursor
        prev_ts = c.ts

    # Kahn over the parent->child DAG so every parent is placed before its
    # children; a rebase or a skewed clock can otherwise put a child below its
    # own parent.
    children: dict[str, list[str]] = {sha: [] for sha in index}
    indeg: dict[str, int] = {sha: 0 for sha in index}
    for c in commits:
        for p in c.parents:
            if p in index:
                children[p].append(c.sha)
                indeg[c.sha] += 1

    depth: dict[str, float] = {}
    queue = deque(sorted((s for s, d in indeg.items() if d == 0), key=lambda s: base[s]))
    while queue:
        sha = queue.popleft()
        c = index[sha]
        floor = max(
            (depth[p] + MIN_DY for p in c.parents if p in depth),
            default=base[sha],
        )
        depth[sha] = max(base[sha], floor)
        for ch in children[sha]:
            indeg[ch] -= 1
            if indeg[ch] == 0:
                queue.append(ch)

    # Negate so that older (small depth) sits at the bottom of the screen and
    # newer (large depth) climbs toward the top.
    for c in commits:
        c.y = -depth.get(c.sha, base[c.sha])


# --------------------------------------------------------------------- pass 3

# Width of a divergence band. Branches inside one band are near enough to
# each other that sharing a column misrepresents neither of them.
DV_BAND = 0.12


def _pack_columns(
    index: dict[str, Commit], refs: list[Ref], main: str, owner: dict[str, str],
    divergences: dict[str, float],
) -> list[dict]:
    """Give each branch the nearest free column whose time span does not collide.

    A column is reused by branches whose lifetimes do not overlap, so its
    occupants have to be alike: the canvas places a column by how far its
    branches have diverged, and one outlier would drag the whole column - and
    every quiet branch sharing it - out to the edge. So columns are filled in
    divergence order and a branch prefers one already holding its own kind.
    """
    spans: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for sha, name in owner.items():
        y = index[sha].y
        span = spans.get(name)
        if span is None:
            spans[name] = [y, y]
        else:
            span[0] = min(span[0], y)
            span[1] = max(span[1], y)
        counts[name] = counts.get(name, 0) + 1

    by_name = {r.name: r for r in refs}
    for ref in refs:   # branches with no commits of their own still get a tip
        spans.setdefault(ref.name, [index[ref.sha].y, index[ref.sha].y])
        counts.setdefault(ref.name, 0)

    # Pack the newest branches nearest the trunk: those are the ones a reader
    # is most likely to care about.
    # Where did each branch fork from? A branch should be drawn next to its
    # source, not wherever the first free column happens to be - otherwise a
    # freshly created merge branch appears to pop up somewhere unrelated.
    anchors = _fork_anchors(index, owner, spans, main)

    # Order decides who gets the columns next to the trunk, because each
    # branch takes the nearest free one. Most recently touched first: on a
    # repository with fifty branches the ones worth reading are the ones
    # somebody pushed to this month, and they should be beside main rather
    # than exiled to the edge. Ties fall back to the newest fork point, then
    # to the branch with the most commits of its own.
    tip_ts = {r.name: r.ts for r in refs}

    def band(name: str) -> int:
        return round(divergences.get(name, 0.0) / DV_BAND)

    ordered = sorted(
        (n for n in spans if n != main),
        key=lambda n: (band(n), -tip_ts.get(n, 0), spans[n][1], -counts[n], n),
    )
    occupied: dict[int, list[tuple[float, float]]] = {}
    col_band: dict[int, int] = {}
    columns: dict[str, int] = {main: 0}

    for name in ordered:
        lo, hi = spans[name]
        # Asymmetric: the name plate hangs above the tip, so that side needs
        # far more room than the foot of the branch does.
        lo -= LABEL_PAD
        hi += LANE_PAD
        want = _lane_offset(columns.get(anchors.get(name, main), 0))
        mine = band(name)
        best, best_cost = None, None
        # Search a bounded set of columns and take the free one that best
        # matches this branch: same divergence band first, then closest to the
        # branch it forked from, then the lower index to break ties.
        for col in range(1, len(spans) * 2 + 4):
            if any(not (hi < s0 or lo > e0) for s0, e0 in occupied.get(col, ())):
                continue
            mismatch = abs(col_band.get(col, mine) - mine)
            cost = (mismatch, abs(_lane_offset(col) - want), col)
            if best_cost is None or cost < best_cost:
                best, best_cost = col, cost
            if cost[0] == 0 and cost[1] == 0:
                break
        col = best if best is not None else 1
        occupied.setdefault(col, []).append((lo, hi))
        col_band[col] = mine
        columns[name] = col

    out = []
    for name, col in sorted(columns.items(), key=lambda kv: kv[1]):
        ref = by_name.get(name)
        lo, hi = spans[name]
        out.append(
            {
                "name": name,
                "lane": col,
                # yTop is the newest end of the line, yBot the oldest.
                "yTop": round(lo, 2),
                "yBot": round(hi, 2),
                "tip": ref.sha if ref else None,
                "tipShort": ref.sha[:7] if ref else None,
                "remote": bool(ref.remote) if ref else False,
                "isHead": bool(ref.is_head) if ref else False,
                "isMain": name == main,
                "ownCommits": counts.get(name, 0),
                "ts": ref.ts if ref else 0,
            }
        )
    return out


def _attach_impact(commits: list[Commit], stats: dict[str, tuple]) -> None:
    """Score how much each commit changed, absolutely and relative to the window."""
    for c in commits:
        ins, dels, files = stats.get(c.sha, (0, 0, 0))
        c.impact = commit_impact(ins, dels, files)
    scale_rel([c.impact for c in commits])


def _fork_anchors(
    index: dict[str, Commit], owner: dict[str, str], spans: dict, main: str
) -> dict[str, str]:
    """For each branch, the branch it split away from."""
    oldest: dict[str, Commit] = {}
    for sha, name in owner.items():
        c = index[sha]
        cur = oldest.get(name)
        if cur is None or c.y > cur.y:      # y grows downward into the past
            oldest[name] = c

    anchors: dict[str, str] = {}
    for name, c in oldest.items():
        anchor = main
        for parent in c.parents:
            p = index.get(parent)
            if p is not None and owner.get(parent) not in (None, name):
                anchor = owner[parent]
                break
        anchors[name] = anchor
    # A branch with no commits of its own (its tip is shared) still needs one.
    for name in spans:
        anchors.setdefault(name, main)
    return anchors


def _lane_offset(lane: int) -> int:
    """Column index -> signed position: 0 is the trunk, odds left, evens right."""
    if lane <= 0:
        return 0
    step = (lane + 1) // 2
    return -step if lane % 2 else step


# ---------------------------------------------------------------------- edges

def _build_edges(commits: list[Commit], index: dict[str, Commit]) -> list[dict]:
    edges = []
    for c in commits:
        for i, p in enumerate(c.parents):
            parent = index.get(p)
            if parent is None:
                # History truncated by the time window: a fading stub downward
                # so the line does not just stop dead.
                edges.append(
                    {
                        "lane0": c.lane, "y0": round(c.y + MIN_DY * 1.2, 2),
                        "lane1": c.lane, "y1": round(c.y, 2),
                        "b": c.branch, "kind": "stub", "merge": False,
                        "c": c.sha, "p": None,
                    }
                )
                continue
            edges.append(
                {
                    # The renderer derives screen x from the column index, so
                    # column pitch can respond to the viewport width.
                    "lane0": parent.lane, "y0": round(parent.y, 2),
                    "lane1": c.lane, "y1": round(c.y, 2),
                    # Colour a merge edge by where it came from, so an incoming
                    # branch keeps its identity right up to the join.
                    "b": parent.branch if i > 0 else c.branch,
                    "kind": "straight" if parent.lane == c.lane else "curve",
                    "merge": i > 0,
                    # Endpoints, so the canvas can pick out the run of commits
                    # joining two branches without asking the server.
                    "c": c.sha, "p": parent.sha,
                }
            )
    return edges
