"""The Oracle: read-only Claude Code invocations, streamed.

Two hard guarantees, enforced by flags rather than by prompt wording:

  --permission-prompts none   anything that would ask for permission is denied
  --allowedTools <read set>   only inspection tools are permitted at all
  --disallowedTools <writes>  belt and braces on the mutating ones

So analysis can never modify the repository. The one operation that *does*
write - creating a merge worktree - is plain git in `worktree.py`, triggered
only by an explicit button press, and never by the model.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from typing import Iterator

READ_ONLY_TOOLS = ",".join(
    [
        "Read", "Grep", "Glob",
        "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
        "Bash(git merge-tree:*)", "Bash(git status:*)", "Bash(git rev-list:*)",
        "Bash(git ls-tree:*)", "Bash(git blame:*)", "Bash(git merge-base:*)",
        "Bash(git for-each-ref:*)", "Bash(git cat-file:*)",
    ]
)

DENIED_TOOLS = ",".join(
    [
        "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch",
        "Bash(git push:*)", "Bash(git commit:*)", "Bash(git merge:*)",
        "Bash(git rebase:*)", "Bash(git checkout:*)", "Bash(git switch:*)",
        "Bash(git reset:*)", "Bash(git worktree:*)", "Bash(git branch:*)",
        "Bash(rm:*)", "Bash(mv:*)",
    ]
)


def available() -> str | None:
    return shutil.which("claude")


def _stream(argv: list[str], cwd: str, timeout: int, outcome: dict) -> Iterator[dict]:
    """Run the CLI and yield its parsed stream-json events, one per line.

    All the process plumbing lives here so the two callers only differ in what
    they make of the events. When the process ends, `outcome` holds `code` and
    `stderr`; a start failure sets `error` instead. Closing the generator kills
    the process rather than leaving an orphan billing tokens into the void, and
    sets `aborted`.
    """
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
        )
    except OSError as exc:
        outcome["error"] = str(exc)
        return

    # Drain stderr on a side thread so a chatty warning cannot deadlock the pipe.
    stderr_chunks: list[str] = []
    threading.Thread(
        target=lambda: stderr_chunks.extend(proc.stderr or ()), daemon=True).start()
    killer = threading.Timer(timeout, proc.kill)
    killer.start()
    try:
        for line in proc.stdout or ():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue
    except GeneratorExit:
        outcome["aborted"] = True
        proc.kill()
        raise
    finally:
        killer.cancel()
        try:
            outcome["code"] = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            outcome["code"] = proc.wait()
        outcome["stderr"] = "".join(stderr_chunks).strip()


def run(prompt: str, cwd: str, model: str = "sonnet", timeout: int = 300) -> Iterator[dict]:
    """Stream a read-only Claude Code run as a sequence of UI events.

    Yields dicts of {type: "text"|"tool"|"status"|"done"|"error", ...}.
    """
    binary = available()
    if not binary:
        yield {
            "type": "error",
            "message": "claude CLI not found on PATH. Install Claude Code to enable the Oracle.",
        }
        return

    argv = [
        binary,
        "--print",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-prompts", "none",
        "--allowedTools", READ_ONLY_TOOLS,
        "--disallowedTools", DENIED_TOOLS,
        "--no-session-persistence",
        "--model", model,
        prompt,
    ]

    yield {"type": "status", "message": f"opening channel :: model={model}"}

    outcome: dict = {}
    events = _stream(argv, cwd, timeout, outcome)
    emitted_text = False
    try:
        for event in events:
            for out in _translate(event):
                if out["type"] == "text":
                    emitted_text = True
                yield out
    finally:
        events.close()
    if outcome.get("aborted"):
        return
    if outcome.get("error"):
        yield {"type": "error", "message": f"could not start claude: {outcome['error']}"}
        return

    if outcome.get("code") and not emitted_text:
        yield {
            "type": "error",
            "message": outcome["stderr"][-600:] or f"claude exited with status {outcome['code']}",
        }
    yield {"type": "done"}


def _translate(event: dict) -> Iterator[dict]:
    """Map Claude Code's stream-json events onto the handful the UI cares about."""
    etype = event.get("type")

    if etype == "stream_event":
        inner = event.get("event", {})
        if inner.get("type") == "content_block_delta":
            delta = inner.get("delta", {})
            if delta.get("type") == "text_delta" and delta.get("text"):
                yield {"type": "text", "text": delta["text"]}
        return

    if etype == "assistant":
        for block in event.get("message", {}).get("content", []) or []:
            if block.get("type") == "tool_use":
                yield {"type": "tool", "name": block.get("name", "?"), "input": _brief(block.get("input"))}
        return

    if etype == "system" and event.get("subtype") == "init":
        yield {
            "type": "status",
            "message": "connected (read-only)",
            "model": event.get("model"),
        }
        return

    if etype == "result":
        yield {
            "type": "result",
            "ok": event.get("subtype") == "success",
            "durationMs": event.get("duration_ms"),
            "costUsd": event.get("total_cost_usd"),
            "usage": _usage(event.get("usage")),
            "model": event.get("model"),
            "turns": event.get("num_turns"),
            # Fall back to the aggregate result when partial deltas were absent.
            "text": event.get("result") if isinstance(event.get("result"), str) else None,
        }


def _usage(usage) -> dict | None:
    """Flatten the token counts so the UI can show exactly what a call cost."""
    if not isinstance(usage, dict):
        return None
    read = usage.get("cache_read_input_tokens") or 0
    write = usage.get("cache_creation_input_tokens") or 0
    inp = usage.get("input_tokens") or 0
    out = usage.get("output_tokens") or 0
    return {
        "input": inp,
        "output": out,
        "cacheRead": read,
        "cacheWrite": write,
        "total": inp + out + read + write,
    }


def _brief(value, limit: int = 110) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        for key in ("command", "pattern", "file_path", "path", "query"):
            if key in value:
                value = value[key]
                break
        else:
            value = json.dumps(value)
    text = str(value).replace("\n", " ")
    return text[:limit] + ("..." if len(text) > limit else "")


EXPLAIN_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["id", "summary"],
            },
        }
    },
    "required": ["items"],
}

EXPLAIN_STYLE = """\
Write each summary in simple, direct English:
- Active voice. Present tense. Say what the change does, not what it "is".
- Start with a verb where you can: "Adds", "Moves", "Fixes", "Replaces".
- Use the real names of files, functions and concepts. Be specific.
- Do not repeat the subject line word for word. Add the context it is missing.
- No filler: no "this commit", no "various", no "several changes".
- One idea per sentence. Keep every sentence short.

Length follows the size of the change, which is marked on each item:
- [small]  one sentence, 12 to 22 words.
- [medium] one or two sentences, up to 38 words.
- [large]  two or three sentences, up to 60 words. Use the extra room to say
           what the parts do and how they fit together, not to add adjectives.
"""


def _explain_prompt(items: list[dict], kind: str) -> str:
    listing = "\n".join(f"  [{it['id']}] {it.get('size', 'medium')} :: {it['text']}" for it in items)
    noun = "commit" if kind == "commits" else "branch"
    return (
        f"Summarise each {noun} below for a git visualisation tool.\n\n"
        f"{EXPLAIN_STYLE}\n"
        f"Return one item per input, using exactly the id given in brackets.\n"
        f"Each item is marked [small], [medium] or [large]. Match that length.\n\n"
        f"{listing}\n\n"
        f"You may read files or run read-only git commands to understand a "
        f"change, but keep it to a few calls - this is a bulk operation."
    )


def _explain_argv(binary: str, prompt: str, model: str, stream: bool) -> list[str]:
    argv = [
        binary, "--print",
        "--output-format", "stream-json" if stream else "json",
        "--json-schema", json.dumps(EXPLAIN_SCHEMA),
        "--permission-prompts", "none",
        "--allowedTools", READ_ONLY_TOOLS,
        "--disallowedTools", DENIED_TOOLS,
        "--no-session-persistence",
        "--model", model,
    ]
    if stream:
        argv += ["--include-partial-messages", "--verbose"]
    argv.append(prompt)
    return argv


def explain_stream(items: list[dict], kind: str, cwd: str,
                   model: str = "haiku", timeout: int = 300):
    """Batch one-line summaries, reporting token use as it happens."""
    binary = available()
    if not binary or not items:
        yield {"type": "done", "summaries": {}, "error": None if items else "nothing to explain"}
        return

    argv = _explain_argv(binary, _explain_prompt(items, kind), model, stream=True)
    outcome: dict = {}
    events = _stream(argv, cwd, timeout, outcome)
    running = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
    final: dict = {}
    try:
        for event in events:
            etype = event.get("type")
            if etype == "stream_event":
                inner = event.get("event", {})
                # message_start carries the input side, message_delta the
                # running output count for the message in flight. The text
                # deltas themselves are skipped: the answer is structured, so
                # there is nothing readable to show until it is complete.
                if inner.get("type") == "message_start":
                    u = (inner.get("message") or {}).get("usage") or {}
                    running["input"] += u.get("input_tokens") or 0
                    running["cacheRead"] += u.get("cache_read_input_tokens") or 0
                    running["cacheWrite"] += u.get("cache_creation_input_tokens") or 0
                elif inner.get("type") == "message_delta":
                    u = inner.get("usage") or {}
                    if u.get("output_tokens") is not None:
                        running["output"] = max(running["output"], u["output_tokens"])
                else:
                    continue
                running["total"] = sum(running[k] for k in ("input", "output", "cacheRead", "cacheWrite"))
                yield {"type": "usage", "usage": dict(running)}
            elif etype == "result":
                final = event
            else:
                # Tool calls and the init line, same shape as an oracle run.
                yield from _translate(event)
    finally:
        events.close()
    if outcome.get("aborted"):
        return
    if outcome.get("error"):
        yield {"type": "done", "summaries": {}, "error": outcome["error"]}
        return

    summaries = _parse_items(final.get("result"))
    yield {
        "type": "done",
        "summaries": summaries,
        "model": final.get("model") or model,
        "costUsd": final.get("total_cost_usd"),
        "usage": _usage(final.get("usage")) or running,
        "durationMs": final.get("duration_ms"),
        "error": None if summaries else (outcome.get("stderr", "")[-400:] or "no summaries returned"),
    }


def _parse_items(payload) -> dict:
    """Pull {id: summary} out of the validated structured reply."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return {}
    if not isinstance(payload, dict):
        return {}
    out = {}
    for row in payload.get("items") or []:
        if isinstance(row, dict) and row.get("id") and row.get("summary"):
            out[str(row["id"])] = str(row["summary"]).strip()
    return out


# ------------------------------------------------------------------- prompts

BRANCH_PROMPT = """\
You are the Oracle of a git world-line viewer. Analyse ONE branch and report \
back for display in a small terminal pane. Do not modify anything.

REFERENCE WORLD LINE : {base}
BRANCH               : {head}
DIVERGENCE READING   : {value} (attractor field {field})
MEASURED             : {explain}

Commits unique to this branch (newest first):
{commits}

Files this branch changed that the reference branch ALSO changed since they split:
{contested}

Write at most 160 words, plain text, no markdown headers, in exactly these \
four labelled sections:

INTENT: what this branch is actually trying to do, in one or two sentences, \
inferred from the commits and file paths.
STATE: how finished it looks, and whether the history is clean or messy.
RISK: the concrete reconciliation hazards. Name real files.
PET PEEVE: the one thing you would push back on in review. Be specific and \
a little blunt. If the branch is genuinely fine, say so instead of inventing \
a complaint.

You may read files and run read-only git commands to check your claims, but \
keep it to a few calls - speed matters here."""


MERGE_PROMPT = """\
You are the Oracle of a git world-line viewer. Two world lines are about to be \
reconciled. Report whether they can converge. Do not modify anything - no \
merging, no committing, no writing files.

WORLD LINE A : {a}
WORLD LINE B : {b}
DIVERGENCE OF B FROM A : {value} (attractor field {field})
MEASURED : {explain}

A real merge has already been performed, without touching the working tree.
This is ground truth, not a guess:

MERGE ENGINE : {engine}
MERGE RESULT : {verdict}
CONFLICTED FILES ({nconf}):
{conflicts}

GIT'S OWN MESSAGES:
{messages}

Commits unique to B:
{commits_b}

Commits unique to A since the split:
{commits_a}

Write at most 220 words, plain text, no markdown headers, in exactly these \
five labelled sections:

VERDICT: MERGEABLE, MERGEABLE WITH CARE, or CONTESTED - then one sentence of why.
COLLISION: for each conflicted file, one line naming the file and what the two \
sides each did to it. If there are no conflicts, say what still overlaps \
semantically even though git is happy.
ORDER: the order to resolve things in, or the rebase/merge strategy you would \
actually use.
BLAST RADIUS: what else might break that git cannot see - callers, tests, \
schemas, config.
PET PEEVE: the one thing about this pair that would annoy you in review.

Read the conflicted files and the relevant diffs before judging. Keep it to a \
handful of tool calls - speed matters here."""


def branch_prompt(base, head, reading, explain_text, commits, contested) -> str:
    return BRANCH_PROMPT.format(
        base=base,
        head=head,
        value=reading["display"],
        field=reading["field"]["glyph"] + " " + reading["field"]["name"],
        explain=explain_text,
        commits=_bullets(f"{c['short']}  {c['subject']}" for c in commits[:25]) or "  (none)",
        contested=_bullets(contested[:25]) or "  (none - no contested files)",
    )


def merge_prompt(a, b, reading, explain_text, merge, commits_a, commits_b) -> str:
    verdict = "CLEAN - git merged without conflict" if merge.get("clean") else "CONFLICTED"
    if not merge.get("ok"):
        verdict = f"COULD NOT MERGE ({merge.get('error')})"
    return MERGE_PROMPT.format(
        a=a,
        b=b,
        value=reading["display"],
        field=reading["field"]["glyph"] + " " + reading["field"]["name"],
        explain=explain_text,
        verdict=verdict,
        engine=(
            "`git merge-tree --write-tree`"
            if merge.get("engine") != "merge-file" else
            "a three-way merge on a scratch index (this git predates "
            "`merge-tree --write-tree`). Renames are not followed, so a file "
            "renamed on one side and edited on the other shows as a conflict "
            "here when git itself would merge it"
        ),
        nconf=len(merge.get("conflicts", [])),
        conflicts=_bullets(merge.get("conflicts", [])[:40]) or "  (none)",
        messages=(merge.get("messages") or "(none)")[:1500],
        commits_b=_bullets(f"{c['short']}  {c['subject']}" for c in commits_b[:20]) or "  (none)",
        commits_a=_bullets(f"{c['short']}  {c['subject']}" for c in commits_a[:20]) or "  (none)",
    )


def _bullets(lines) -> str:
    return "\n".join(f"  - {line}" for line in lines)
