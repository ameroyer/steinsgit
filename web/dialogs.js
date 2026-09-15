/* Modal dialogs: help and settings, rescan, merge, export, first run. */
(() => {
"use strict";
const SG = window.SG;
const $ = (id) => document.getElementById(id);

/** Offer a full pass, but only ever on a first look at a repository.
 *
 *  Once anything has been analysed the dialog stops appearing by itself and
 *  lives under HELP, next to the settings. An offer to spend money is welcome
 *  once; every time you open the page it is a nag.
 */
async function maybeOfferFullRun() {
  let plan;
  try { plan = await SG.api("/api/plan"); } catch { return; }
  if (!plan.askOnOpen || !plan.fresh) return;
  if (!plan.commitsToExplain && !plan.branchesToAnalyse) return;
  rememberNotToAsk();          // shown once is shown; HELP has it from here on
  showRunPlan(plan);
}

const MODELS = ["opus", "sonnet", "haiku"];
const modelOptions = (sel) => MODELS.map(m =>
  `<option value="${m}"${m === sel ? " selected" : ""}>${m}</option>`).join("");

/** Read the days/max-commits inputs and post the new window. */
const postWindow = (daysEl, maxEl) => {
  const days = parseInt(daysEl.value, 10);
  const maxCommits = parseInt(maxEl.value, 10);
  return SG.post("/api/window", {
    days: Number.isNaN(days) ? undefined : days,
    maxCommits: Number.isNaN(maxCommits) ? undefined : maxCommits,
  });
};

/** What has already been paid for. The first thing anyone needs before being
 *  asked to spend again is what the last run bought. */
function planDone(plan) {
  const d = plan.done || {};
  const sp = d.spend || {};
  const nothing = !d.commitsExplained && !d.branchesDescribed && !d.branchesAnalysed;
  if (nothing) {
    return `<div class="i-note">Nothing in this repository has been analysed yet.</div>`;
  }
  return `
    <h4>ALREADY DONE</h4>
    <div class="statgrid">
      <div class="stat"><div class="n">${d.commitsExplained}/${plan.commitsTotal}</div>
        <div class="l">COMMITS EXPLAINED</div></div>
      <div class="stat"><div class="n">${d.branchesDescribed}/${plan.branchesTotal}</div>
        <div class="l">BRANCHES DESCRIBED</div></div>
      <div class="stat"><div class="n">${d.branchesAnalysed}/${plan.branchesTotal}</div>
        <div class="l">BRANCHES REVIEWED</div></div>
      <div class="stat"><div class="n">$${(sp.costUsd || 0).toFixed(2)}</div>
        <div class="l">SPENT SO FAR</div></div>
    </div>
    <div class="i-note">${d.lastAt
      ? `Last written ${SG.esc(SG.when(d.lastAt))} (${SG.ago(d.lastAt)})` +
        (d.firstAt && d.firstAt !== d.lastAt
          ? `, first ${SG.esc(SG.when(d.firstAt))}.` : ".") +
        ` Running again only covers what is missing - anything already written
          is reused, not bought twice.`
      : "Nothing recorded yet."}</div>`;
}

/** The body of the run dialog, shared by the first-run modal and the HELP tab
 *  so the two can never drift apart. */
function planBody(plan) {
  const e = plan.estimate;
  const price = e
    ? `About <b>${SG.num(e.tokens)} tokens</b> and <b>$${e.costUsd.toFixed(2)}</b> for what
       is left, based on the ${e.basedOn} call(s) this repository has already made.`
    : `We cannot estimate the cost yet, because this repository has made no
       calls before. The first run will tell us.`;
  return `
    <p>Claude can read every commit and branch in your window and write a short
       explanation of each. It reads only. It cannot change your files.</p>

    ${planDone(plan)}

    <h4>STILL TO DO</h4>
    <div class="statgrid">
      <div class="stat"><div class="n">${plan.commitsToExplain}</div><div class="l">COMMITS TO EXPLAIN</div></div>
      <div class="stat"><div class="n">${plan.branchesToAnalyse}</div><div class="l">BRANCHES TO REVIEW</div></div>
      <div class="stat"><div class="n">${plan.calls}</div><div class="l">CLAUDE CALLS</div></div>
      <div class="stat"><div class="n">${plan.days || "all"}</div><div class="l">DAYS OF HISTORY</div></div>
    </div>

    ${plan.large ? `<div class="warnbox">
      This is a big run. ${plan.commitsToExplain} commits is a lot to read.
      Reduce the number of days below if you only need recent work.</div>` : ""}

    <p>${price}</p>

    <h4>WHAT TO READ</h4>
    <div class="setrow">
      <div><div class="lab">Days of history</div>
        <div class="hint">0 reads the whole history. This is the fastest way to
          make the run smaller and cheaper.</div></div>
      <div class="right"><input id="planDays" type="number" min="0" max="3650"
        value="${plan.days ?? 0}"></div>
    </div>
    <div class="setrow">
      <div><div class="lab">Most commits to load</div>
        <div class="hint">A safety limit for very large repositories.</div></div>
      <div class="right"><input id="planMax" type="number" min="50" max="50000" step="50"
        value="${plan.maxCommits ?? 2000}"></div>
    </div>

    <h4>WHICH MODELS</h4>
    <div class="setrow">
      <div><div class="lab">Model for explanations</div>
        <div class="hint">Writes the one-line commit and branch summaries.
          Bulk work, so a small model is usually right.</div></div>
      <div class="right"><select id="planExplain">${modelOptions(plan.explainModel)}</select></div>
    </div>
    <div class="setrow">
      <div><div class="lab">Model for analysis</div>
        <div class="hint">Reviews one branch at a time, one call each. Slower,
          more careful, and the expensive half.</div></div>
      <div class="right"><select id="planModel">${modelOptions(plan.model)}</select></div>
    </div>

    <h4>WHAT TO RUN</h4>
    <div class="setrow">
      <div><div class="lab">Explain commits</div>
        <div class="hint">One short summary each, over ${SG.num(plan.commitsTotal)}
          commit(s), ${plan.batches} call(s) using
          <b>${SG.esc(plan.explainModel)}</b>.</div></div>
      <div class="right"><input type="checkbox" id="runCommits" checked></div>
    </div>
    <div class="setrow sub">
      <div><div class="lab">…at most</div>
        <div class="hint">The newest commits, of the ${SG.num(plan.commitsLoaded)}
          loaded. 0 for no cap. The rest stay on the canvas either way - this
          caps only what is read.</div></div>
      <div class="right"><input id="planExplainLimit" type="number" min="0" max="100000"
        step="10" value="${plan.explainLimit || 0}"> commits</div>
    </div>
    <div class="setrow">
      <div><div class="lab">Describe branches</div>
        <div class="hint">The one line each branch page shows, over
          ${SG.num(plan.branchesTotal)} branch(es). Thirty to a call, so
          ${plan.describeBatches} call(s) using
          <b>${SG.esc(plan.explainModel)}</b>. Cheap.</div></div>
      <div class="right"><input type="checkbox" id="runDescribe" checked></div>
    </div>
    <div class="setrow">
      <div><div class="lab">Review branches</div>
        <div class="hint"><b>One call per branch</b> on
          <b>${SG.esc(plan.model)}</b>, reading its commits and diffs -
          ${plan.branchesToAnalyse} of them. This is nearly all of what a run
          costs and takes; untick it, or cap the branches above, to get the
          descriptions on their own.</div></div>
      <div class="right"><input type="checkbox" id="runReview" checked></div>
    </div>
    <div class="setrow sub">
      <div><div class="lab">…at most</div>
        <div class="hint">The most recently touched branches, of the
          ${SG.num(plan.branchesLoaded)} loaded, for <b>both</b> rows above.
          0 for no cap. This is the number that decides what a run costs.</div></div>
      <div class="right"><input id="planBranchLimit" type="number" min="0" max="100000"
        step="5" value="${plan.branchLimit || 0}"> branches</div>
    </div>
    <button class="act" id="runNow">RUN IT</button>`;
}

/** Wire the controls in a rendered plan body. `rerender` is handed a fresh
 *  plan whenever the window or the models change, so the numbers on screen
 *  always describe the run you are about to start. */
function wirePlanBody(rerender) {
  const reprice = async (apply) => {
    const btn = $("runNow");
    if (btn) { btn.disabled = true; btn.textContent = "READING…"; }
    try {
      await apply();
      await SG.load();
      rerender(await SG.api("/api/plan"));
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "RUN IT"; }
      // Report into the plan's own pane when it has one, so an error does not
      // land at the bottom of the help text it happens to be sitting inside.
      const host = $("pane-run") || SG.el.modalBody;
      host.innerHTML += `<div class="warnbox">${SG.esc(err.message)}</div>`;
    }
  };

  for (const id of ["planDays", "planMax"]) {
    $(id)?.addEventListener("change", () =>
      reprice(() => postWindow($("planDays"), $("planMax"))));
  }
  for (const id of ["planModel", "planExplain", "planExplainLimit", "planBranchLimit"]) {
    $(id)?.addEventListener("change", () => reprice(() => SG.post("/api/settings", {
      model: $("planModel").value,
      explainModel: $("planExplain").value,
      explainLimit: parseInt($("planExplainLimit").value, 10) || 0,
      branchLimit: parseInt($("planBranchLimit").value, 10) || 0,
    })));
  }
  $("runNow")?.addEventListener("click", async () => {
    const wantCommits = $("runCommits").checked;
    const wantDescribe = $("runDescribe").checked;
    const wantReview = $("runReview").checked;
    closeModal();
    await SG.runFullAnalysis(wantCommits, wantDescribe, wantReview);
  });
}

function showRunPlan(plan) {
  const render = (p) => {
    openModal("ANALYSE THIS REPOSITORY?", planBody(p), null, null);
    SG.el.modalCancel.textContent = "NOT NOW";
    SG.el.modalActions.style.display = "";
    SG.el.modalOk.style.display = "none";
    wirePlanBody(render);
  };
  render(plan);
}

/** Never offer the opening run for this repository again. */
function rememberNotToAsk() {
  SG.post("/api/settings", { askOnOpen: false }).catch(() => {});
}

// ------------------------------------------------------------------ dialogs

// The cancel and × buttons are wired once, in app.js. This only sets what the
// dialog says and what OK does.
function openModal(title, bodyHtml, okLabel, onOk) {
  SG.el.modalCancel.textContent = "CANCEL";
  SG.el.modalTitle.textContent = title;
  SG.el.modalBody.innerHTML = bodyHtml;
  SG.el.modal.classList.remove("hidden");
  SG.el.modalActions.style.display = onOk ? "" : "none";
  SG.el.modalOk.disabled = false;      // a dialog never opens mid-progress
  SG.el.modalOk.style.display = "";
  if (onOk) { SG.el.modalOk.textContent = okLabel; SG.el.modalOk.onclick = onOk; }
}

const closeModal = () => SG.el.modal.classList.add("hidden");

function showHelp(tab) {
  // Nothing is awaited before the dialog opens: help must appear the moment it
  // is asked for. The ANALYSE and SETTINGS panes each fill themselves in when
  // their numbers arrive.
  const planSoon = SG.api("/api/plan").catch(() => null);
  const cfgSoon = SG.api("/api/settings").catch(() => ({}));

  openModal("STEINS;GIT", `
    <div class="tabs">
      <button class="tab" data-pane="help">WHAT THIS IS</button>
      <button class="tab" data-pane="run">ANALYSE</button>
      <button class="tab" data-pane="settings">SETTINGS</button>
    </div>

    <div class="pane" id="pane-run"><div class="pending">READING THE REPOSITORY…</div></div>

    <div class="pane" id="pane-help">
      <p>This page shows the branches of your git repository.</p>
      <p>Time goes up. The oldest commit is at the bottom. The newest commits are at the top.
         The thick white line is your default branch. Each other branch is a line next to it.
         Each circle is one commit. Each diamond is a merge commit.</p>

      <h4>THE DIVERGENCE NUMBER</h4>
      <p>The number at the top shows how far a branch moved away from the default branch.
         <code>0.000000</code> means no difference. A high number means a large difference.
         The colour shows the same thing: <span class="good">green</span> is a small difference,
         <span class="bad">orange and red</span> are large differences.</p>

      <h4>HOW WE CALCULATE IT</h4>
      <p>We measure six things. We give each one a weight. Then we add them together.</p>
      <table class="help-t">
        <tr><td>overlap</td><td>0.28</td><td>Files that both branches changed. These files can cause conflicts. This is the most important measure.</td></tr>
        <tr><td>churn</td><td>0.18</td><td>How many lines the branch added and removed.</td></tr>
        <tr><td>ahead</td><td>0.16</td><td>How many commits are only on this branch.</td></tr>
        <tr><td>age</td><td>0.14</td><td>How many days since the two branches separated.</td></tr>
        <tr><td>behind</td><td>0.12</td><td>How many commits the branch does not have yet.</td></tr>
        <tr><td>spread</td><td>0.12</td><td>How many different files the branch changed.</td></tr>
      </table>
      <p>Each measure has a limit. A change from 2 commits to 12 commits has a large effect.
         A change from 400 commits to 410 commits has almost no effect.</p>

      <h4>COMMIT SIZE</h4>
      <p>Each commit has its own number. It shows how much that one commit changed.
         Large circles are large commits. Click a circle to see the files.</p>

      <h4>HOW TO USE IT</h4>
      <p>To see branch details, click a branch line.<br>
         To see commit details, click a circle.<br>
         To compare two branches, click two branch lines. Then click <b>ASK CLAUDE TO COMPARE</b>.<br>
         To make a test merge, click <b>CREATE MERGE WORKTREE</b>. This does not change your current files.</p>

      <h4>SINGLING OUT ONE BRANCH</h4>
      <p>Double-click a branch. Its column moves to the middle of the screen, and the only
         other branches left in the foreground are the ones it is actually tied to: what it
         forked from, what forked from it, what it merged in, and what merged it.
         Click empty canvas to come back.</p>

      <h4>PICKING A PAIR</h4>
      <p>Click two branches and the view moves onto them: the road between them is
         highlighted, the two are given room, and every other branch steps back into the
         background. Click empty canvas, or press <b>Escape</b>, to put them back.</p>

      <h4>THE HIGHLIGHTED PATH</h4>
      <p>Click one branch and we light up every commit between it and the default branch,
         down to the last commit they both have. Click two branches and we do the same
         for the pair. That commit is marked <b>COMMON ANCESTOR</b>.</p>
      <p>Everything lit up happened after the two sides last agreed. That is the work a
         merge has to reconcile, so it is the part worth reading.</p>

      <h4>FILTERING</h4>
      <p>The box above the branch list takes a regular expression. Branches that do not
         match are not hidden. They get thinner and fainter and give most of their width
         to the branches that do match. A curve between two columns is drawn only if the
         branches at both ends matched, so the fan of joins belonging to everything else
         goes away. The view then moves onto what is left and zooms in to fit it.
         Empty the box to put everything back.</p>

      <h4>WHY LINES CHANGE COLOUR</h4>
      <p>A line is drawn in the colour of the branch it belongs to. The default branch is
         white. So a line leaving the trunk is that branch's colour, not white, and it
         fades from white into that colour along the curve, because that is what it is:
         the trunk becoming a branch. A line merging back fades the other way.</p>

      <h4>COMMITS CLAUDE HELPED WITH</h4>
      <p>The checkbox above the branch list rings every commit whose message carries a
         <code>Co-Authored-By</code> line naming a model. The author is still whoever made
         the commit, so a commit by a person can be marked - that is the normal case, and
         the tooltip names the model that was credited.</p>
      <p>It can only see commits that say so. Work done with a model and committed without
         the trailer looks like anything else.</p>

      <h4>ONE LINE PER BRANCH</h4>
      <p>If a branch exists both on your machine and on the remote, we draw it once, using
         your local copy. That is the one you can check out and merge. How far the remote
         copy has drifted is shown under <b>REMOTE COPY</b> when you click the branch.</p>

      <h4>WHERE A BRANCH SITS</h4>
      <p>The default branch is the line down the middle. Every other branch sits out to
         one side, and how far out says how far it has diverged: the columns nearest the
         middle are the branches nearest to merging cleanly. It is the same thing the
         colour says.</p>

      <h4>MOVING AROUND</h4>
      <p>Commits are drawn far enough apart to be read, so a long history is taller than
         the screen. Drag, or hold <b>shift</b> and scroll, to travel along it.
         Scroll to zoom. Press <b>f</b> to go back to the newest commits.
         Click an empty part of the canvas to clear the selection.</p>

      <h4>RUNNING THE ANALYSIS</h4>
      <p>The <b>ANALYSE</b> tab above runs Claude over the repository: a line about each
         commit, a line about each branch, and a longer review of each branch. You can cap
         how many of each it runs on - the newest commits and the most recently touched
         branches - without narrowing what is loaded and drawn.
         It opens with what has already been written and when, and a run only covers
         what is missing. You are offered this once, the first time you open a
         repository; after that it lives here.</p>

      <h4>ABOUT CLAUDE</h4>
      <p>Claude can read your repository. Claude cannot change it. We block the tools that write files.</p>
      <p>We show the model name, the token count and the cost of every call.
         We save each answer. If you ask the same question again, you get the saved answer.</p>
    </div>

    <div class="pane" id="pane-settings"><div class="pending">READING…</div></div>
  `, null, null);

  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => selectTab(t.dataset.pane));
  }
  selectTab(tab || "help");

  // Re-rendering the plan must not throw away the help around it, so it is
  // redrawn in place and the pane it lives in stays selected.
  const rerender = (next) => {
    const host = $("pane-run");
    if (!host) return;                       // the dialog was closed meanwhile
    host.innerHTML = next
      ? planBody(next)
      : '<div class="warnbox">Could not read the plan for this repository.</div>';
    if (next) wirePlanBody(rerender);
  };
  planSoon.then(rerender);
  cfgSoon.then((cfg) => {
    const host = $("pane-settings");
    if (!host) return;
    host.innerHTML = settingsPane(cfg);
    const save = async () => {
      try {
        const next = await SG.post("/api/settings", {
          model: $("setModel").value,
          explainModel: $("setExplain").value,
          forge: $("setForge").value,
        });
        if (SG.state.snap) SG.state.snap.repo.model = next.model;
        await SG.load(true);            // links depend on the forge choice
      } catch { /* leave the control as the user set it */ }
    };
    for (const id of ["setModel", "setExplain", "setForge"]) {
      $(id)?.addEventListener("change", save);
    }
    $("setExport")?.addEventListener("click", doExport);
  });
}

function settingsPane(cfg) {
  const f = cfg.forgeInfo || {};
  const sp = cfg.spend || {};
  return `
    <div class="statgrid">
      <div class="stat"><div class="n">${sp.calls || 0}</div><div class="l">CLAUDE CALLS</div></div>
      <div class="stat"><div class="n">$${(sp.costUsd || 0).toFixed(4)}</div><div class="l">TOTAL COST</div></div>
    </div>

    <div class="setrow">
      <div><div class="lab">Model for analysis</div>
        <div class="hint">Used to compare branches and analyse one branch. Slower and more careful.</div></div>
      <div class="right"><select id="setModel">${modelOptions(cfg.model)}</select></div>
    </div>

    <div class="setrow">
      <div><div class="lab">Model for explanations</div>
        <div class="hint">Used to write the one-line commit and branch summaries. This is bulk work, so a small model is usually right.</div></div>
      <div class="right"><select id="setExplain">${modelOptions(cfg.explainModel)}</select></div>
    </div>

    <div class="setrow">
      <div><div class="lab">Link commits to</div>
        <div class="hint">${f.remoteUrl
          ? `Remote: <code>${SG.esc(f.remoteUrl)}</code><br>Detected: <b>${SG.esc(f.detected)}</b>`
          : "This repository has no remote, so no links can be made."}</div></div>
      <div class="right"><select id="setForge">
        ${["auto", "github", "gitlab", "bitbucket", "none"].map(k =>
          `<option value="${k}"${cfg.forge === k ? " selected" : ""}>${k === "none" ? "off" : k}</option>`).join("")}
      </select></div>
    </div>

    <div class="setrow">
      <div><div class="lab">Export this view</div>
        <div class="hint">Writes one HTML file with the graph, the numbers and every saved
          Claude answer. It has no external links and works offline.</div></div>
      <div class="right"><button class="act" id="setExport" style="margin:0">EXPORT</button></div>
    </div>`;
}

function selectTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.dataset.pane === name);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === "pane-" + name);
}

function showRescan() {
  // The spend total needs a request; the dialog does not wait for it.
  const cfgSoon = SG.api("/api/settings").catch(() => ({}));
  const r = SG.state.snap ? SG.state.snap.repo : {};
  const kb = r.cache || {};
  const rows = Object.values(kb.kinds || {}).reduce((n, k) => n + k.rows, 0);

  openModal("RESCAN THE REPOSITORY", `
    <p>A rescan re-reads git. <b>It does not call Claude and it costs nothing.</b>
       Saved Claude answers are kept.</p>

    <div class="statgrid">
      <div class="stat"><div class="n">${r.commitCount ?? "-"}</div><div class="l">COMMITS NOW</div></div>
      <div class="stat"><div class="n">${r.branchCount ?? "-"}</div><div class="l">BRANCHES NOW</div></div>
      <div class="stat"><div class="n">${SG.ago(r.scannedAt) || "-"}</div><div class="l">LAST READ</div></div>
      <div class="stat"><div class="n">${r.fromCache ? "reused" : `${r.scanMs ?? "-"} ms`}</div><div class="l">LAST READ TOOK</div></div>
    </div>

    <h4>SAVED DATA</h4>
    <div class="setrow"><div><div class="lab">Knowledge base</div>
      <div class="hint">Measurements, merge tests and Claude answers, kept so nothing is
        computed or paid for twice.</div></div>
      <div class="right">${rows} entries · ${Math.round((kb.bytes || 0) / 1024)} KB</div></div>
    <div class="setrow"><div><div class="lab">Claude spend so far</div>
      <div class="hint">Every model call this repository has made, in total.</div></div>
      <div class="right" id="rsSpend">…</div></div>

    <h4>WHAT TO READ</h4>
    <div class="setrow"><div><div class="lab">Days of history</div>
      <div class="hint">0 reads the whole history. A larger number is slower.</div></div>
      <div class="right"><input id="rsDays" type="number" min="0" max="3650" value="${r.days ?? 90}"></div></div>
    <div class="setrow"><div><div class="lab">Most commits to load</div>
      <div class="hint">A safety limit for very large repositories.</div></div>
      <div class="right"><input id="rsMax" type="number" min="50" max="50000" step="50" value="${r.maxCommits ?? 2000}"></div></div>
  `, "READ IT AGAIN", async () => {
    SG.el.modalOk.disabled = true;
    SG.el.modalOk.textContent = "READING…";
    try {
      await postWindow($("rsDays"), $("rsMax"));
      closeModal();
      await SG.load();
    } catch (err) {
      SG.el.modalBody.innerHTML += `<div class="warnbox">${SG.esc(err.message)}</div>`;
    } finally {
      SG.el.modalOk.disabled = false;
      SG.el.modalOk.textContent = "READ IT AGAIN";
    }
  });
  cfgSoon.then((cfg) => {
    const sp = cfg.spend || {};
    const slot = $("rsSpend");
    if (slot) slot.textContent = `${sp.calls || 0} calls · $${(sp.costUsd || 0).toFixed(4)}`;
  });
}

/** A saved comparison for the pair about to be merged, if one exists. */
async function priorComparison(a, b) {
  try {
    const hist = await SG.api(`/api/history?ref=${encodeURIComponent(a)}`);
    const row = (hist.history || []).find(h =>
      h.kind === "merge" && (h.refs || []).includes(a) && (h.refs || []).includes(b));
    if (!row) return null;
    const full = await SG.api(`/api/analysis?key=${encodeURIComponent(row._key)}`);
    return full && full.text ? full : null;
  } catch { return null; }
}

async function confirmWorktree() {
  if (!SG.state.a || !SG.state.b) return;
  const m = SG.state.pairReading && SG.state.pairReading.merge;
  const [prior, dup] = await Promise.all([
    priorComparison(SG.state.a, SG.state.b),
    SG.api(`/api/worktree/check?a=${encodeURIComponent(SG.state.a)}&b=${encodeURIComponent(SG.state.b)}`)
      .then(r => r.existing || []).catch(() => []),
  ]);
  openModal("CREATE A MERGE WORKTREE", `
    <p>This makes a <b>new branch in a separate folder</b> and tries the merge there.
       Your current files do not change.</p>
    ${dup.length ? `<div class="softwarn">
      <b>You already made ${dup.length === 1 ? "a merge test" : dup.length + " merge tests"} for this pair.</b>
      <div class="sub">${dup.map(x => `<code>${SG.esc(x.branch)}</code>${
        x.unresolved && x.unresolved.length
          ? `, still has ${x.unresolved.length} unresolved file(s)`
          : x.clean === true ? ", merged cleanly" : ""}${
        x.path ? `<br><span class="sm">${SG.esc(x.path)}</span>` : ""}`).join("<br>")}</div>
      <div class="sub">Making another is fine. It gets its own branch and folder.</div>
    </div>` : ""}
    ${SG.kv("base (A)", SG.esc(SG.shortRef(SG.state.a)))}
    ${SG.kv("merge in (B)", SG.esc(SG.shortRef(SG.state.b)))}
    ${SG.kv("folder", "<code>.steinsgit/worldlines/…</code>")}
    ${m && !m.clean ? `<div class="warnbox">${m.conflicts.length} file(s) will conflict.
      The merge stops and leaves the conflicts for you to fix:<br>
      ${m.conflicts.map(SG.esc).join("<br>")}</div>` : ""}
    ${m && m.clean ? `<p class="good">The merge should complete with no conflicts.</p>` : ""}
    ${prior ? `<h4>WHAT CLAUDE SAID ABOUT THIS PAIR</h4>
      <div class="prior">
        <div class="sm">${SG.esc(prior.model || "")} · ${SG.when(prior.at)} (${SG.ago(prior.at)})${
          prior.costUsd ? " · $" + prior.costUsd.toFixed(4) : ""}</div>
        <pre>${SG.markLabels(SG.esc(prior.text))}</pre>
      </div>` : `<p class="sm">No saved comparison for this pair.
        Close this and click ASK CLAUDE TO COMPARE to get one first.</p>`}
  `, "CREATE", async () => {
    SG.el.modalOk.disabled = true;
    SG.el.modalOk.textContent = "CREATING…";
    try {
      const res = await SG.post("/api/worktree", { a: SG.state.a, b: SG.state.b });
      closeModal();
      await SG.load(true);
      SG.view.markSpawn(res.branch);      // grow the new line into the graph
      SG.state.focus = res.branch;
      SG.view.setSelection({ focus: res.branch });
      showWorktreeReport(res);
      // A new branch with no description is exactly the thing that looks like
      // it came from nowhere, so describe it straight away.
      SG.explainStream("branches", [res.branch], {
        button: $("wtExplainBtn"),
      }).then(r => {
        const text = (r.summaries || {})[res.branch];
        const host = $("wtDesc");
        if (text && host) { host.textContent = text; host.classList.remove("hidden"); }
        const cost = $("wtCost");
        if (cost) cost.innerHTML = SG.costLine(r);
      });
    } catch (err) {
      SG.el.modalBody.innerHTML += `<div class="warnbox">${SG.esc(err.message)}</div>`;
    } finally {
      SG.el.modalOk.disabled = false;
      SG.el.modalOk.textContent = "CREATE";
    }
  });
}

/** What actually happened in the new worktree, and what to do next. */
function showWorktreeReport(res) {
  const nConf = (res.conflicts || []).length;
  SG.openInspector(`
    <div class="i-kind">NEW WORKTREE</div>
    <div class="i-title">${SG.esc(SG.shortRef(res.branch))}</div>
    <div class="i-sha">${SG.esc(SG.shortRef(res.base))} ← ${SG.esc(SG.shortRef(res.incoming))}</div>

    <div class="big" style="color:${nConf ? "var(--red)" : "var(--green)"}">
      ${nConf ? `${nConf} conflict${nConf > 1 ? "s" : ""}` : "clean"}</div>
    <div class="i-cap">${nConf ? "fix these before you commit" : "the merge finished on its own"}</div>
    <div id="wtDesc" class="bdesc hidden"></div>
    <div id="wtCost"></div>
    <button class="act ghost" id="wtExplainBtn">ASKING CLAUDE…</button>

    ${nConf ? `
      <div class="i-sec">FILES YOU MUST FIX</div>
      <div class="flist">${res.conflicts.map(f =>
        `<div><span class="p">${SG.esc(f.path)}</span>
          <span class="n">${f.hunks} spot${f.hunks === 1 ? "" : "s"}</span></div>`).join("")}</div>
      <div class="i-note">Each spot is marked in the file with
        <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>. Keep the correct lines and delete the markers.</div>
    ` : `
      <div class="i-sec">WHAT THE MERGE BROUGHT IN</div>
      ${SG.kv("merge commit", res.commit || "-")}
      ${SG.kv("files changed", res.changedCount || 0)}
      <div class="flist">${(res.changed || []).map(f =>
        `<div><span class="p">${SG.esc(f.path)}</span>
          <span class="n"><span class="add">+${f.insertions}</span>
            <span class="del">-${f.deletions}</span></span></div>`).join("") || "<div>-</div>"}</div>
    `}

    <div class="i-sec">NEXT STEPS</div>
    <ol class="steps">${(res.nextSteps || []).map(t => `<li>${SG.esc(t)}</li>`).join("")}</ol>

    <div class="i-sec">WHERE IT IS</div>
    <div class="pathbox">${SG.esc(res.path)}</div>
    <div class="i-note">Your original checkout did not change.
      To remove this later, run
      <code>git worktree remove ${SG.esc(res.relPath)}</code>.</div>
  `);
}

async function doExport() {
  const btn = $("setExport");
  if (btn) { btn.disabled = true; btn.textContent = "EXPORTING…"; }
  try {
    const res = await SG.post("/api/export", { includeAnalyses: true });
    openModal("EXPORT READY", `
      <p>We made one HTML file. It contains everything: the graph, the numbers,
         and ${res.analyses} saved Claude answer(s).</p>
      <p>The file has no external links. You can open it offline, send it to somebody,
         or publish it as an artifact.</p>
      ${SG.kv("file", `<code>${SG.esc(res.name)}</code>`)}
      ${SG.kv("size", `${Math.round(res.bytes / 1024)} KB`)}
      ${SG.kv("saved in", "<code>.steinsgit/exports/</code>")}
      <p><a class="dl" href="${SG.esc(res.url)}" download>DOWNLOAD THE FILE</a>
         &nbsp;<a class="dl ghost" href="${SG.esc(res.url)}" target="_blank" rel="noopener">OPEN IT</a></p>
    `, null, null);
  } catch (err) {
    openModal("EXPORT FAILED", `<div class="warnbox">${SG.esc(err.message)}</div>`, null, null);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "EXPORT"; }
  }
}

SG.closeModal = closeModal;
SG.showHelp = showHelp;
SG.showRescan = showRescan;
SG.confirmWorktree = confirmWorktree;
SG.maybeOfferFullRun = maybeOfferFullRun;
})();
