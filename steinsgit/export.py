"""Export the current view as a single self-contained HTML file.

The page inlines the stylesheet, the renderer, and the data, so it works from
`file://` with no server and no network. Pan, zoom and hover stay live because
`render.js` has no dependencies of its own.
"""

from __future__ import annotations

import html
import json
import os
import time

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def _read(name: str) -> str:
    with open(os.path.join(WEB, name), "r", encoding="utf-8") as fh:
        return fh.read()


def build(snapshot: dict, analyses: list[dict], note: str | None = None,
          summaries: dict[str, str] | None = None, forge=None) -> str:
    repo = snapshot["repo"]
    generated = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    summaries = summaries or {}

    # One compact row per branch for the left pane. The wide six-column table
    # this used to be cannot live in a column beside a detail pane, and the
    # columns it dropped are all on the right-hand side anyway.
    rows = []
    for b in snapshot["branches"]:
        risk = round(b["conflictRisk"] * 100)
        second = ("default branch" if b["isMain"]
                  else f"{b['ahead']} ahead · {b['behind']} behind · {risk}% overlap")
        rows.append(
            f"<div class='bitem{' main' if b['isMain'] else ''}'"
            f" data-branch='{html.escape(b['name'])}' title='{html.escape(b['name'])}'>"
            f"<div class='row1'><span class='nm'>{html.escape(b['label'])}</span>"
            f"<span class='dv'>{b['display']}</span></div>"
            f"<div class='row2'>{html.escape(second)}"
            f"{' <span class=badge>remote</span>' if b['remote'] else ''}</div></div>"
        )

    # Per-branch commit lists, built from the graph that is already in hand
    # rather than by asking git again: one pass, no extra work, and it carries
    # the saved one-line summaries with it so the page explains itself.
    details: dict[str, list] = {}
    for c in snapshot["graph"]["commits"]:
        if not c.get("branch"):
            continue
        details.setdefault(c["branch"], []).append({
            "sha": c["sha"], "short": c["short"], "subject": c["subject"],
            "author": c["author"], "ts": c["ts"], "merge": c["merge"],
            "ai": c.get("ai", False),
            "aiWith": c.get("aiWith") or "",
            "impact": (c.get("impact") or {}).get("display"),
            "rel": (c.get("impact") or {}).get("rel", 0),
            "summary": summaries.get(c["sha"]),
            "url": forge.commit(c["sha"]) if forge and forge.available else None,
        })
    for rowset in details.values():
        rowset.sort(key=lambda r: -r["ts"])

    cards = []
    for a in analyses:
        u = a.get("usage") or {}
        meta = [a.get("model") or "?"]
        if u.get("total"):
            meta.append(f"{u['total']:,} tokens")
        if a.get("costUsd"):
            meta.append(f"${a['costUsd']:.4f}")
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(a.get("at", 0))) if a.get("at") else ""
        cards.append(
            f"<div class='card'><div class='card-h'>"
            f"<b>{html.escape(a.get('title') or 'analysis')}</b>"
            f"<span class='sm'>{html.escape(when)} · {html.escape(' · '.join(meta))}</span>"
            f"</div><pre>{html.escape(a.get('text', ''))}</pre></div>"
        )

    # An export is meant to be sent to other people, so the absolute path
    # (which contains the user's home directory) is left out of it.
    shareable = {k: v for k, v in repo.items() if k not in ("path", "cache", "forge")}
    payload = {
        "repo": shareable,
        "graph": snapshot["graph"],
        "branches": snapshot["branches"],
        "details": details,
    }
    project = (forge.to_json().get("project") if forge and forge.available else None)
    home = (forge.info["base"] if forge and forge.available else None)

    return f"""<!doctype html>
<meta charset="utf-8">
<title>{html.escape(repo['name'])}: branch divergence</title>
<style>{_read('style.css')}</style>
<style>
  body{{overflow:auto; display:block; padding:0 0 60px}}
  .wrap{{max-width:1180px; margin:0 auto; padding:26px 22px}}
  h1{{font-size:19px; letter-spacing:.2em; color:var(--amber-hot); font-weight:400; margin:0 0 4px}}
  .sub{{color:var(--ink-faint); font-size:11px; letter-spacing:.12em; margin-bottom:22px}}
  #exportCanvas{{width:100%; height:60vh; min-height:380px; border:1px solid var(--line);
                 background:#0a0a09; display:block; border-radius:3px}}
  table{{width:100%; border-collapse:collapse; margin-top:22px; font-size:12px}}
  th{{text-align:left; color:var(--ink-faint); font-weight:400; font-size:9.5px;
      letter-spacing:.22em; border-bottom:1px solid var(--line); padding:6px 8px}}
  td{{padding:6px 8px; border-bottom:1px solid rgba(214,204,184,.06); color:var(--ink)}}
  tr.main td{{background:rgba(246,241,230,.04)}}
  td.nm{{color:var(--ink)}} td.dv{{color:var(--amber); letter-spacing:.05em}}
  td.sm,.sm{{color:var(--ink-faint); font-size:10.5px}}
  .badge{{border:1px solid var(--line-2); color:var(--ink-faint); font-size:8.5px;
          padding:0 4px; border-radius:2px; margin-left:5px}}
  .card{{border:1px solid var(--line); border-left:2px solid var(--amber);
         margin-top:14px; background:rgba(255,255,255,.02)}}
  .card-h{{display:flex; justify-content:space-between; gap:12px; padding:8px 12px;
           border-bottom:1px solid var(--line); font-size:11.5px; color:var(--ink)}}
  .card pre{{margin:0; padding:12px; white-space:pre-wrap; font-size:11.5px;
             line-height:1.6; color:var(--ink-dim)}}
  h2{{font-size:10px; letter-spacing:.26em; color:var(--ink-faint); font-weight:400;
      margin:30px 0 0; border-bottom:1px solid var(--line); padding-bottom:5px}}
  .note{{border-left:2px solid var(--green); padding:8px 12px; margin:16px 0;
         background:rgba(111,191,115,.05); color:var(--ink); font-size:12px}}

  .brandrow{{display:flex; align-items:center; gap:13px; margin-bottom:6px}}
  .brandrow .mark svg{{width:40px; height:40px; display:block; border-radius:8px}}
  .wordmark{{font-size:10px; letter-spacing:.34em; color:var(--ink-faint)}}
  .brandrow h1{{margin:2px 0 0}}
  a.forge{{margin-left:auto; font-size:11px; letter-spacing:.06em; color:var(--amber);
           text-decoration:none; border:1px solid var(--line-2); border-radius:3px;
           padding:5px 10px}}
  a.forge:hover{{border-color:var(--amber)}}

  .detail{{border:1px solid var(--line); border-radius:3px; margin-top:16px;
           background:rgba(255,255,255,.015)}}
  .detail .empty{{padding:14px; color:var(--ink-faint); font-size:11.5px}}
  .detail .dh{{display:flex; align-items:baseline; gap:10px; padding:10px 13px;
               border-bottom:1px solid var(--line)}}
  .detail .dh .nm{{font-size:13px; color:var(--ink); letter-spacing:.04em}}
  .detail .dh .dv{{font-size:12px}}
  .detail .dh .sm{{margin-left:auto}}
  .clist{{max-height:420px; overflow-y:auto}}
  .crow{{padding:8px 13px; border-bottom:1px solid rgba(214,204,184,.05)}}
  .crow:last-child{{border-bottom:0}}
  .crow .c1{{display:flex; gap:8px; align-items:baseline; font-size:12px}}
  .crow .s{{color:var(--amber); font-size:10.5px}}
  .crow .sub2{{flex:1; color:var(--ink)}}
  .crow .sub2 a{{color:var(--ink); text-decoration:none; border-bottom:1px dotted var(--line-2)}}
  .crow .sub2 a:hover{{color:var(--amber)}}
  .crow .cdesc{{color:var(--ink-dim); font-size:11px; margin-top:3px; line-height:1.5}}
  .crow .a{{color:var(--ink-faint); font-size:10px; margin-top:3px}}
  .crow .bar{{height:2px; background:rgba(214,204,184,.08); margin-top:5px}}
  .crow .bar i{{display:block; height:2px}}
  .aidot{{color:#92ff40; font-size:9.5px; letter-spacing:.1em}}
  /* Two panes, as in the tool itself: the list you choose from on the left,
     what you chose on the right. Stacking them put a long branch list between
     the graph and the thing it explains. */
  .panes{{display:flex; gap:14px; align-items:flex-start; margin-top:16px}}
  .pane-left{{flex:0 0 288px; border:1px solid var(--line); border-radius:3px;
              background:rgba(255,255,255,.015); overflow:hidden}}
  .pane-right{{flex:1 1 auto; min-width:0; position:sticky; top:14px}}
  .pane-h{{padding:8px 12px; font-size:9px; letter-spacing:.26em; color:var(--ink-faint);
           border-bottom:1px solid var(--line); background:#0c0c0a}}
  .pane-h .sm{{float:right; letter-spacing:.06em}}
  .blist{{max-height:70vh; overflow-y:auto}}
  .bitem{{padding:7px 12px; border-bottom:1px solid rgba(214,204,184,.06); cursor:pointer}}
  .bitem:hover{{background:rgba(255,157,46,.06)}}
  .bitem.on{{background:rgba(255,157,46,.11)}}
  .bitem.main{{background:rgba(246,241,230,.035)}}
  .bitem .row1{{display:flex; gap:8px; align-items:baseline}}
  .bitem .nm{{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
              font-size:12px; color:var(--ink)}}
  .bitem.main .nm{{color:#f6f1e6; font-weight:600}}
  .bitem .dv{{font-size:11px; color:var(--amber); letter-spacing:.04em}}
  .bitem .row2{{font-size:10px; color:var(--ink-faint); margin-top:2px}}
  .detail{{margin-top:0}}
  @media (max-width: 860px) {{
    .panes{{flex-direction:column}}
    .pane-left{{flex:1 1 auto; width:100%}}
    .pane-right{{position:static; width:100%}}
  }}
</style>
<div id="crt"><div id="scanlines"></div><div id="vignette"></div></div>
<div class="wrap">
  <div class="brandrow">
    <span class="mark">{_read('favicon.svg')}</span>
    <div>
      <div class="wordmark">STEINS;GIT</div>
      <h1>{html.escape(repo['name'])}</h1>
    </div>
    {f'<a class="forge" href="{html.escape(home)}" target="_blank" rel="noopener">{html.escape(project or home)} &#8599;</a>' if home else ''}
  </div>
  <div class="sub">branch divergence from <b>{html.escape(repo.get('mainLabel') or repo['main'])}</b>
    · {repo['commitCount']} commits · {repo['branchCount']} branches
    · window {repo.get('days') or 'all'} days · exported {generated}</div>

  {f'<div class="note">{html.escape(note)}</div>' if note else ''}

  <canvas id="exportCanvas"></canvas>
  <div class="sub" style="margin-top:8px">drag to pan · scroll to zoom · time runs upward
    · click a branch or a commit for its detail</div>

  <div class="panes">
    <aside class="pane-left">
      <div class="pane-h">BRANCHES <span class="sm">{repo['branchCount']}</span></div>
      <div class="blist">{''.join(rows)}</div>
    </aside>
    <section class="pane-right">
      <div id="detail" class="detail"><div class="empty">Pick a branch, on the canvas
        or in the list, to see its commits.</div></div>
    </section>
  </div>

  {'<h2>SAVED ANALYSES</h2>' + ''.join(cards) if cards else ''}
</div>
<script>{_read('render.js')}</script>
<script>
  var STATE = {json.dumps(payload)};
  var esc = function (t) {{
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {{
      return {{"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}}[c];
    }});
  }};
  var when = function (ts) {{
    var d = new Date(ts * 1000), p = function (n) {{ return String(n).padStart(2, "0"); }};
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }};
  var byName = {{}};
  STATE.branches.forEach(function (b) {{ byName[b.name] = b; }});

  var host = document.getElementById("detail");

  // The same detail the live tool shows in its inspector, minus anything that
  // would need a server: what the branch is, and every commit on it with
  // whatever Claude wrote about it at the time of the export.
  function showBranch(name, focusSha) {{
    var b = byName[name];
    if (!b) return;
    var commits = STATE.details[name] || [];
    var colour = view.heatCss(b.divergence, b.isMain);
    var rows = commits.map(function (c) {{
      var subject = c.url
        ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.subject) + "</a>"
        : esc(c.subject);
      return '<div class="crow"' + (c.sha === focusSha ? ' style="background:rgba(255,157,46,.07)"' : "") + ">" +
        '<div class="c1"><span class="s">' + esc(c.short) + "</span>" +
        '<span class="sub2">' + subject + "</span>" +
        (c.ai ? '<span class="aidot" title="co-authored with ' +
                esc(c.aiWith || "a model") + '">CO-AUTHORED</span>' : "") +
        '<span class="dv" style="color:' + colour + '">' + esc(c.impact || "-") + "</span></div>" +
        (c.summary ? '<div class="cdesc">' + esc(c.summary) + "</div>" : "") +
        '<div class="a">' + esc(c.author) + " · " + when(c.ts) + (c.merge ? " · merge" : "") + "</div>" +
        '<div class="bar"><i style="width:' + Math.round((c.rel || 0) * 100) +
        '%;background:' + colour + '"></i></div></div>';
    }}).join("") || '<div class="empty">No commits of its own inside this window.</div>';

    host.innerHTML =
      '<div class="dh"><span class="nm">' + esc(b.label || name) + "</span>" +
      '<span class="dv" style="color:' + colour + '">' + esc(b.display) + "</span>" +
      '<span class="sm">' + esc(b.summary) + "</span>" +
      (b.url ? '<a class="forge" href="' + esc(b.url) + '" target="_blank" rel="noopener">open &#8599;</a>' : "") +
      '</div><div class="clist">' + rows + "</div>";
    markList(name);
  }}

  var view = Renderer.create(document.getElementById('exportCanvas'), {{
    onPick: function (hit) {{
      if (!hit) return;
      if (hit.type === "commit") {{
        view.setSelection({{ focus: hit.commit.branch }});
        showBranch(hit.commit.branch, hit.commit.sha);
      }} else {{
        view.setSelection({{ focus: hit.branch }});
        showBranch(hit.branch);
      }}
    }},
  }});
  view.setData(STATE.graph, STATE.branches, STATE.repo.main);
  setTimeout(function(){{ view.resize(); view.fit(false); }}, 30);

  var items = document.querySelectorAll("[data-branch]");
  Array.prototype.forEach.call(items, function (item) {{
    item.addEventListener("click", function () {{
      var name = item.getAttribute("data-branch");
      view.setSelection({{ focus: name }});
      showBranch(name);
    }});
  }});
  // Keep the list in step with whatever the canvas selected, and vice versa.
  function markList(name) {{
    Array.prototype.forEach.call(items, function (item) {{
      item.classList.toggle("on", item.getAttribute("data-branch") === name);
    }});
  }}
</script>
"""
