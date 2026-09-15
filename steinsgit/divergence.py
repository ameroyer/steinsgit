"""Divergence metric.

The number on the meter has to satisfy two things at once: it must look like a
Divergence Meter reading (d.dddddd, seven nixie tubes) and it must actually
mean something about the branch.

So we compute six normalised components from real git measurements and take a
weighted sum in [0, 1], then scale to [0, 2). Every component saturates
exponentially - the difference between 2 and 12 commits ahead matters a lot,
the difference between 400 and 410 does not.

The heaviest weight goes to *file overlap*: the share of files the branch
touched that the reference branch also touched since they split. That is the
single best cheap predictor of how painful reconciliation will be, and it is
what makes the meter useful rather than decorative.
"""

from __future__ import annotations

import math
import time

from .gitdata import Repo

# name, lower bound, flavour used in the readout
ATTRACTOR_FIELDS = [
    ("alpha",   "α", 0.00, "Convergent. Reconciliation is routine."),
    ("beta",    "β", 0.25, "Mild drift. Merge while it is still cheap."),
    ("gamma",   "γ", 0.50, "Notable divergence. Expect manual review."),
    ("delta",   "δ", 0.75, "Heavy divergence. Overlapping edits likely."),
    ("epsilon", "ε", 1.00, "Severe. Reconciliation will be contested."),
    ("zeta",    "ζ", 1.25, "Critical. Consider rebasing onto the spine."),
    ("eta",     "η", 1.50, "Beyond the attractor field. Histories barely relate."),
]

WEIGHTS = {
    "ahead": 0.16,     # how much unique work sits on this line
    "behind": 0.12,    # how much of the reference it has not absorbed
    "churn": 0.18,     # volume of change
    "spread": 0.12,    # breadth of change across the tree
    "overlap": 0.28,   # contested files - the real reconciliation cost
    "age": 0.14,       # how long ago the world lines split
}

# Scale constants: the value at which each component reaches ~63% saturation.
SCALE = {"ahead": 10.0, "behind": 30.0, "churn": 600.0, "spread": 25.0, "age": 21.0}


def _saturate(value: float, scale: float) -> float:
    """Map [0, inf) to [0, 1) with diminishing returns."""
    if value <= 0:
        return 0.0
    return 1.0 - math.exp(-value / scale)


def field_for(value: float) -> dict:
    entry = ATTRACTOR_FIELDS[0]
    for candidate in ATTRACTOR_FIELDS:
        if value >= candidate[2]:
            entry = candidate
    name, glyph, lower, flavour = entry
    return {"name": name, "glyph": glyph, "lower": lower, "flavour": flavour}


def compute(repo: Repo, base_ref: str, head_ref: str, now: int | None = None) -> dict:
    """Divergence of `head_ref` measured against `base_ref`."""
    now = now or int(time.time())

    if base_ref == head_ref:
        return _reading(0.0, base_ref, head_ref, {}, {}, reference=True)

    base = repo.merge_base(base_ref, head_ref)
    if base is None:
        # Unrelated histories: there is no world line connecting these at all.
        raw = {"unrelated": True}
        return _reading(1.999999, base_ref, head_ref, raw, {}, unrelated=True)

    ahead, behind = repo.ahead_behind(base_ref, head_ref)
    ins, dels, head_paths = repo.numstat(f"{base_ref}...{head_ref}")
    _, _, base_paths = repo.numstat(f"{head_ref}...{base_ref}")
    contested = sorted(head_paths & base_paths)
    base_ts = repo.commit_ts(base)
    age_days = max(0.0, (now - base_ts) / 86400.0) if base_ts else 0.0

    components = {
        "ahead": _saturate(ahead, SCALE["ahead"]),
        "behind": _saturate(behind, SCALE["behind"]),
        "churn": _saturate(ins + dels, SCALE["churn"]),
        "spread": _saturate(len(head_paths), SCALE["spread"]),
        "overlap": (len(contested) / len(head_paths)) if head_paths else 0.0,
        "age": _saturate(age_days, SCALE["age"]),
    }
    score = sum(components[k] * WEIGHTS[k] for k in WEIGHTS)
    value = min(1.999999, 2.0 * score)

    raw = {
        "ahead": ahead,
        "behind": behind,
        "insertions": ins,
        "deletions": dels,
        "filesChanged": len(head_paths),
        "filesContested": len(contested),
        "contested": contested[:40],
        "mergeBase": base[:10],
        "mergeBaseTs": base_ts,
        "ageDays": round(age_days, 1),
        "unrelated": False,
    }
    return _reading(value, base_ref, head_ref, raw, components)


def _reading(
    value: float,
    base_ref: str,
    head_ref: str,
    raw: dict,
    components: dict,
    reference: bool = False,
    unrelated: bool = False,
) -> dict:
    display = f"{value:.6f}"
    field = {
        "name": "theta",
        "glyph": "θ",
        "lower": 0.0,
        "flavour": "Reference world line. All divergence is measured from here.",
    } if reference else field_for(value)
    return {
        "value": round(value, 6),
        "display": display,
        "digits": list(display.replace(".", "")),
        "field": field,
        "base": base_ref,
        "head": head_ref,
        "components": {k: round(v, 4) for k, v in components.items()},
        "weights": WEIGHTS,
        # Conflict risk is surfaced on its own because it drives the merge panel.
        "conflictRisk": round(components.get("overlap", 1.0 if unrelated else 0.0), 4),
        "raw": raw,
        "pending": None,
        "reference": reference,
        "unrelated": unrelated,
    }


# Per-commit impact uses tighter scales than branch divergence: a single
# commit touching 8 files is already a big one, whereas a branch touching 8
# files is ordinary.
COMMIT_SCALE = {"lines": 180.0, "files": 8.0}
COMMIT_WEIGHTS = {"lines": 0.58, "files": 0.42}


def commit_impact(insertions: int, deletions: int, files: int) -> dict:
    """How much one commit changed, on the same 0-2 scale as the meter."""
    lines = insertions + deletions
    parts = {
        "lines": _saturate(lines, COMMIT_SCALE["lines"]),
        "files": _saturate(files, COMMIT_SCALE["files"]),
    }
    value = min(1.999999, 2.0 * sum(parts[k] * COMMIT_WEIGHTS[k] for k in parts))
    # No attractor field here. It is a pure function of the value, and this
    # dict is repeated once per commit: on a large repository the flavour text
    # alone would add hundreds of kilobytes to every response.
    return {
        "value": round(value, 6),
        "display": f"{value:.6f}",
        "insertions": insertions,
        "deletions": deletions,
        "files": files,
    }


def scale_rel(impacts: list[dict]) -> None:
    """Add `rel`, each impact relative to the largest of the group.

    The absolute value is what gets displayed; the relative one drives node
    size, so even a set of uniformly small commits still shows which ones
    were the largest.
    """
    peak = max((i["value"] for i in impacts), default=0.0)
    for i in impacts:
        i["rel"] = round(i["value"] / peak, 4) if peak > 0 else 0.0


# An unfinished merge is content that is really there, sitting in the worktree,
# even though nothing has been committed. Weight for the share of files that
# still conflict, added on top of the content the merge brings in.
CONFLICT_WEIGHT = 0.5


def compute_pending_merge(
    repo: Repo, base_ref: str, head_ref: str, incoming: str,
    unresolved: int, now: int | None = None,
) -> dict:
    """Divergence for a branch that is mid-merge.

    Measuring the branch tip alone is misleading: a merge stopped by conflicts
    never commits, so the tip can be identical to the reference and read
    0.000000 while two files sit unresolved on disk. Measure what the finished
    merge would bring in, then add weight for the part that does not merge
    cleanly.
    """
    reading = compute(repo, base_ref, incoming, now=now)
    touched = max(1, reading["raw"].get("filesChanged", 0) or 1)
    ratio = min(1.0, unresolved / touched)
    value = min(1.999999, reading["value"] + CONFLICT_WEIGHT * ratio)

    merged = _reading(value, base_ref, head_ref, reading["raw"], reading["components"])
    merged["components"]["conflict"] = round(ratio, 4)
    merged["weights"] = {**reading["weights"], "conflict": CONFLICT_WEIGHT}
    merged["conflictRisk"] = round(max(reading["conflictRisk"], ratio), 4)
    merged["pending"] = {
        "incoming": incoming,
        "unresolved": unresolved,
        "filesInMerge": touched,
        "ofIncoming": reading["display"],
    }
    merged["raw"] = {**reading["raw"], "pendingUnresolved": unresolved}
    return merged


def explain(reading: dict) -> str:
    """One-line human summary, also fed to Claude as context."""
    r = reading.get("raw", {})
    if reading.get("reference"):
        return "reference world line"
    if reading.get("unrelated"):
        return "unrelated histories - no common ancestor"
    pending = reading.get("pending")
    if pending:
        return (
            f"merge of {pending['incoming']} in progress: "
            f"{pending['unresolved']} of {pending['filesInMerge']} file(s) still conflict, "
            f"incoming content alone would read {pending['ofIncoming']}"
        )
    return (
        f"{r.get('ahead', 0)} ahead / {r.get('behind', 0)} behind, "
        f"+{r.get('insertions', 0)}/-{r.get('deletions', 0)} across "
        f"{r.get('filesChanged', 0)} files, "
        f"{r.get('filesContested', 0)} of them also touched on {reading['base']}, "
        f"split {r.get('ageDays', 0)} days ago"
    )
