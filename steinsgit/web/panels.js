/* The inspector panel: branches, commits and merge-test worktrees. */
(() => {
"use strict";
const SG = window.SG;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- inspector
function openInspector(html) {
  SG.el.inspectorBody.innerHTML = html;
  SG.el.inspector.classList.remove("hidden");
  SG.view.resize();
}

async function showBranch(name) {
  const b = SG.state.byName.get(name);
  if (!b) return;
  const color = SG.view.heatCss(b.divergence, b.isMain);
  openInspector(`<div class="i-kind">BRANCH</div>
    <div class="i-title">${SG.esc(b.label || name)}</div>
    <div class="i-sha">${b.tipShort || ""} · ${b.ownCommits} commits · ${SG.ago(b.ts)}</div>
    <div class="pending">MEASURING…</div>`);
  try {
    // History is one section near the bottom; it must not hold up the page.
    const histSoon = SG.api(`/api/history?ref=${encodeURIComponent(name)}`)
      .catch(() => ({ history: [] }));
    const d = await SG.api(`/api/branch?name=${encodeURIComponent(name)}`);
    SG.state.branchDetail = d;
    const r = d.reading, raw = r.raw || {};
    const comps = Object.entries(r.components || {})
      .sort((x, y) => y[1] * r.weights[y[0]] - x[1] * r.weights[x[0]]);

    openInspector(`
      <div class="i-kind">BRANCH</div>
      <div class="i-title">${SG.esc(b.label || name)}${d.isWorldline ? '<span class="wl-badge">MERGE TEST</span>' : ""}</div>
      <div class="i-sha">${b.tipShort || ""}${b.remote ? " · remote" : ""} · ${b.ownCommits} commits · ${SG.ago(b.ts)}</div>
      ${d.isWorldline ? renderWorktreeState(d) : ""}

      <div class="big" style="color:${color}">${r.display}</div>
      <div class="i-cap">difference from ${SG.esc(SG.state.snap.repo.mainLabel)} · level ${SG.esc(r.field.name)}</div>
      <div class="i-note">${SG.esc(r.field.flavour)}</div>
      <div id="branchDesc" class="bdesc${(d.summary || SG.state.explains.get("branch:" + name)) ? "" : " hidden"}">${SG.esc(d.summary || SG.state.explains.get("branch:" + name) || "")}</div>

      <button class="act" id="askOracle">ASK CLAUDE ABOUT THIS BRANCH</button>
      ${renderTracking(d.tracking)}
      ${renderMergedFrom(d)}
      ${renderLinks([
        [d.url, "OPEN BRANCH"],
        [d.compareUrl, `COMPARE WITH ${SG.state.snap.repo.mainLabel}`],
      ])}
      <div id="histSlot"></div>

      <div class="i-sec">MEASUREMENTS</div>
      ${SG.kv("commits only here", raw.ahead ?? 0)}
      ${SG.kv("commits it is missing", raw.behind ?? 0)}
      ${SG.kv("lines", `<span class="good">+${SG.num(raw.insertions)}</span> <span class="bad">-${SG.num(raw.deletions)}</span>`)}
      ${SG.kv("files changed", raw.filesChanged ?? 0)}
      ${SG.kv("files also changed on ${main}".replace("${main}", SG.esc(SG.state.snap.repo.mainLabel)), raw.filesContested ?? 0)}
      ${SG.kv("separated", `${raw.ageDays ?? 0} days ago`)}
      ${SG.kv("common ancestor", raw.mergeBase || "-")}

      <div class="i-sec">WHAT MAKES UP THE NUMBER</div>
      ${comps.map(([k, v]) => `
        <div class="comp"><span>${k}</span><b>${(v * r.weights[k] * 2).toFixed(3)}</b></div>
        <div class="bar" style="--c:${color}"><i style="width:${Math.round(v * 100)}%"></i></div>
      `).join("")}

      ${(raw.contested || []).length ? `
        <div class="i-sec">FILES CHANGED ON BOTH SIDES</div>
        <div class="contested">${raw.contested.map(SG.esc).join("<br>")}</div>` : ""}

      <div class="i-sec">COMMITS
        <span class="sec-tools">
          <select id="sortBy" title="sort the commits">
            <option value="date">date</option>
            <option value="divergence">change size</option>
          </select>
          <button id="sortDir" class="mini" title="reverse the order">▼</button>
        </span>
      </div>
      <button class="act ghost" id="explainBtn">EXPLAIN THESE COMMITS</button>
      <div class="clist" id="clist"></div>
    `);
    histSoon.then((hist) => {
      const slot = $("histSlot");
      if (!slot) return;                 // another panel replaced this one
      slot.innerHTML = renderHistory(hist.history);
      wireHistory();
    });
    $("askOracle")?.addEventListener("click", () => SG.runOracleBranch(name, false));
    $("explainBtn")?.addEventListener("click", () => SG.explainCommits(name));
    for (const a of SG.el.inspectorBody.querySelectorAll(".mfrom a")) {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        const target = a.dataset.branch;
        if (SG.state.byName.has(target)) { SG.state.focus = target; SG.view.focusBranch(target); }
        showBranch(target);
      });
    }
    $("sortBy").value = SG.state.sort.by;
    $("sortDir").textContent = SG.state.sort.dir === "desc" ? "▼" : "▲";
    $("sortBy").addEventListener("change", (ev) => {
      SG.state.sort.by = ev.target.value; renderCommitList();
    });
    $("sortDir").addEventListener("click", () => {
      SG.state.sort.dir = SG.state.sort.dir === "desc" ? "asc" : "desc";
      $("sortDir").textContent = SG.state.sort.dir === "desc" ? "▼" : "▲";
      renderCommitList();
    });
    renderCommitList();
  } catch (err) {
    openInspector(`<div class="i-kind">BRANCH</div><div class="i-title">${SG.esc(SG.shortRef(name))}</div>
      <div class="bad">${SG.esc(err.message)}</div>`);
  }
}

/** Live state of a merge-test worktree: what is still unresolved right now. */
function renderWorktreeState(d) {
  const w = d.worktree;
  if (!w) {
    return `<div class="i-note">This branch was made by this tool to try a merge.
      Its folder is gone, so there is nothing left to resolve.</div>`;
  }
  const n = w.unresolvedCount;
  return `
    <div class="wstate ${n ? "bad" : "good"}">
      <div class="wn">${n ? `${n} file${n === 1 ? "" : "s"} still conflicting` : "no conflicts left"}</div>
      <div class="wsub">${n
        ? `${w.hunks} marked spot${w.hunks === 1 ? "" : "s"} to fix${w.mergeInProgress ? " · merge still open" : ""}`
        : w.mergeInProgress ? "all files resolved. Run git commit to finish" : "merge finished"}</div>
    </div>
    ${n ? `<div class="i-sec">FILES TO FIX</div>
      <div class="flist">${w.unresolved.map(f =>
        `<div><span class="p">${f.url
            ? `<a class="flink" href="${SG.esc(f.url)}" target="_blank" rel="noopener"
                 title="open ${SG.esc(f.path)} on the remote">${SG.esc(f.path)}</a>`
            : SG.esc(f.path)}</span>
          <span class="n">${f.hunks} spot${f.hunks === 1 ? "" : "s"}</span></div>`).join("")}</div>`
      : ""}
    <div class="pathbox">${SG.esc(w.path)}</div>`;
}

/** Where this branch stands against the remote it shares a name with.
 *
 *  The canvas draws one line per branch, so the remote copy is not on it. This
 *  is where it goes instead: the same two questions the second line used to
 *  answer by existing - has anyone else moved it, and does mine still match.
 */
function renderTracking(t) {
  if (!t) return "";
  const standing = t.inSync
    ? '<span class="good">in step with the remote</span>'
    : [t.ahead ? `<span class="bad">${t.ahead} commit(s) the remote does not have</span>` : "",
       t.behind ? `<span class="bad">${t.behind} commit(s) you do not have</span>` : ""]
      .filter(Boolean).join(" · ");
  return `<div class="i-sec">REMOTE COPY</div>
    <div class="track">
      <div class="track-state">${standing}</div>
      ${SG.kv("tracking", `<code>${SG.esc(t.remote)}</code>`)}
      ${SG.kv("its tip", `${SG.esc(t.short)} · ${SG.ago(t.ts)}`)}
      ${t.ahead ? SG.kv("to publish yours", `<code>git push</code>`) : ""}
      ${t.behind ? SG.kv("to take theirs", `<code>git pull</code>`) : ""}
    </div>
    <div class="i-note">Both copies are drawn as one line. The numbers here are
      this branch against its remote, not against the default branch.</div>`;
}

function renderMergedFrom(d) {
  if (!d.mergedFrom || !d.mergedFrom.length) return "";
  return `<div class="i-sec">BUILT FROM</div>
    <div class="mfrom">${d.mergedFrom.map(m => `
      <a href="#" data-branch="${SG.esc(m.name)}">
        <span class="role ${m.role === "base" ? "base" : "into"}">${SG.esc((m.role || "").toUpperCase())}</span>
        <span class="nm">${SG.esc(m.label)}</span>
        <span class="sh">${SG.esc(m.sha)}</span>
      </a>`).join("")}</div>
    <div class="i-note">Click either one to open it. This branch is the result of
      merging the second into the first.</div>`;
}

/** External links, or a plain reason why there are none. */
function renderLinks(pairs) {
  const live = pairs.filter(([href]) => href);
  if (live.length) {
    return live.map(([href, label]) =>
      `<a class="extlink" href="${SG.esc(href)}" target="_blank" rel="noopener">${SG.esc(label)} ↗</a>`
    ).join(" ");
  }
  const f = (SG.state.snap && SG.state.snap.repo && SG.state.snap.repo.forge) || {};
  if (!f.remoteUrl) {
    return `<div class="nolinks">No web links: this repository has no
      <code>origin</code> remote.</div>`;
  }
  if (f.kind === "none" || f.kind === "unknown") {
    return `<div class="nolinks">No web links: we could not tell what
      <code>${SG.esc(f.host || "that host")}</code> runs.
      Set it by hand in the settings panel.</div>`;
  }
  return "";
}

function renderCommitList() {
  const host = $("clist");
  const d = SG.state.branchDetail;
  if (!host || !d) return;
  const rows = (d.commits || []).slice();
  const { by, dir } = SG.state.sort;
  const sign = dir === "desc" ? -1 : 1;
  rows.sort((p, q) => by === "divergence"
    ? sign * ((p.impact?.value || 0) - (q.impact?.value || 0))
    : sign * (p.ts - q.ts));

  host.innerHTML = rows.slice(0, 60).map(c => {
    const i = c.impact || {};
    const col = SG.view.heatCss(i.value || 0, false);
    const desc = c.summary || SG.state.explains.get(c.sha) || null;
    return `<div class="crow">
      <div class="c1">
        <span class="s">${c.short}</span>
        <span class="csub">${c.url
          ? `<a class="flink" href="${SG.esc(c.url)}" target="_blank" rel="noopener">${SG.esc(c.subject)}</a>`
          : SG.esc(c.subject)}</span>
        <span class="cdv" style="color:${col}" title="how much this commit changed">${i.display || "-"}</span>
      </div>
      <div class="cbar"><i style="width:${Math.round((i.rel || 0) * 100)}%;background:${col}"></i></div>
      ${desc ? `<div class="cdesc">${SG.esc(desc)}</div>` : ""}
      <div class="a">${SG.esc(c.author)} · ${SG.ago(c.ts)} ·
        <span class="good">+${SG.num(i.insertions)}</span>
        <span class="bad">-${SG.num(i.deletions)}</span> · ${i.files || 0} file(s)</div>
    </div>`;
  }).join("") || "<div>-</div>";
}

function renderHistory(rows) {
  if (!rows || !rows.length) return "";
  return `<div class="i-sec">SAVED CLAUDE ANSWERS</div>
    <div class="hist">${rows.map(h => `
      <div class="hrow" data-key="${SG.esc(h._key)}">
        <div class="h1"><span>${SG.esc(h.title || h.kind || "analysis")}</span>
          <span class="sm" title="${SG.esc(SG.when(h.at || h._created))}">${SG.when(h.at || h._created)}</span></div>
        <div class="h2 sm">${SG.esc(h.model || "?")}${h.usage && h.usage.total ? " · " + SG.num(h.usage.total) + " tokens" : ""}${h.costUsd ? " · $" + h.costUsd.toFixed(4) : ""}</div>
        <div class="h3">${SG.esc(h.preview || "")}…</div>
      </div>`).join("")}</div>`;
}

function wireHistory() {
  for (const row of SG.el.inspectorBody.querySelectorAll(".hrow")) {
    row.addEventListener("click", async () => {
      try {
        const a = await SG.api(`/api/analysis?key=${encodeURIComponent(row.dataset.key)}`);
        SG.oracleReset(a.title || "SAVED ANSWER");
        SG.el.oracle.classList.remove("busy");
        SG.sysLine("sys", `» saved answer from ${SG.when(a.at)} (${SG.ago(a.at)})`);
        SG.showUsage(a);
        SG.showAnswer(a.text || "");
      } catch (err) { /* the row simply stays inert */ }
    });
  }
}

async function showCommit(sha) {
  openInspector(`<div class="i-kind">COMMIT</div><div class="i-title">${sha.slice(0, 10)}</div>
    <div class="pending">READING…</div>`);
  try {
    const c = await SG.api(`/api/commit?sha=${encodeURIComponent(sha)}`);
    const node = SG.view.commit(sha);
    const i = (node && node.impact) || null;
    const color = i ? SG.view.heatCss(i.value, false) : "var(--amber)";
    openInspector(`
      <div class="i-kind">COMMIT${c.parents.length > 1 ? " · MERGE" : ""}</div>
      <div class="i-title">${SG.esc(c.subject)}</div>
      <div class="i-sha">${c.short} · ${SG.esc(c.author)} · ${SG.when(c.ts)}</div>
      ${node && node.ai ? `<div class="aicredit">co-authored with
        ${SG.esc(node.aiWith || "a model")}</div>` : ""}
      ${renderLinks([[c.url, "OPEN COMMIT"]])}
      ${i ? `<div class="big" style="color:${color}">${i.display}</div>
             <div class="i-cap">change size, level ${SG.esc(SG.levelFor(i.value).name)}</div>
             <div class="i-note">This shows how much this one commit changed.
               Bigger circles on the graph are bigger commits.</div>` : ""}
      <div id="commitDesc" class="bdesc${c.summary ? "" : " hidden"}">${SG.esc(c.summary || "")}</div>
      <div id="commitCost">${SG.costLine(c.explainCost)}</div>
      <button class="act ghost" id="explainOne">${c.summary ? "EXPLAIN AGAIN" : "EXPLAIN THIS COMMIT"}</button>
      ${c.body ? `<div class="msg">${SG.esc(c.body.trim())}</div>` : ""}
      <div class="i-sec">WHAT CHANGED</div>
      ${SG.kv("files", c.file_count)}
      ${SG.kv("lines", `<span class="good">+${SG.num(c.insertions)}</span> <span class="bad">-${SG.num(c.deletions)}</span>`)}
      ${SG.kv("parents", c.parents.map(p => p.slice(0, 7)).join(", ") || "none (first commit)")}
      <div class="i-sec">FILES</div>
      ${c.parents.length > 1 ? `<div class="i-note">This is a merge. Forges show no
        combined diff for one, so each file below links to its contents at this
        commit rather than to a diff.</div>` : ""}
      <div class="flist">${c.files.map(f =>
        `<div><span class="p">${(c.parents.length > 1 ? f.blobUrl : f.url) || f.url
            ? `<a class="flink" href="${SG.esc((c.parents.length > 1 && f.blobUrl) || f.url)}" target="_blank" rel="noopener">${SG.esc(f.path)}</a>`
            : SG.esc(f.path)}</span>
          <span class="n"><span class="add">+${f.insertions}</span> <span class="del">-${f.deletions}</span></span></div>`
      ).join("") || "<div>-</div>"}</div>

    `);
    $("explainOne")?.addEventListener("click", () => SG.explainOneCommit(c.sha, !!c.summary));
  } catch (err) {
    openInspector(`<div class="bad">${SG.esc(err.message)}</div>`);
  }
}

SG.openInspector = openInspector;
SG.showBranch = showBranch;
SG.renderCommitList = renderCommitList;
SG.showCommit = showCommit;
})();
