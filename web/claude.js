/* Talking to Claude: streaming calls, token accounting, the output pane. */
(() => {
"use strict";
const SG = window.SG;
const $ = (id) => document.getElementById(id);

/** Explain every commit, then analyse every branch, reporting as it goes.
 *
 *  A batch of thirty is one call and can take a minute. Without something that
 *  moves in between, the pane prints a line and then sits there, and a run
 *  that is working is indistinguishable from one that has wedged - so the
 *  whole run is tracked: which step, how far through, how long it has been
 *  going, and what the call in flight is doing right now.
 */
async function runFullAnalysis(wantCommits, wantDescribe, wantReview) {
  oracleReset("FULL ANALYSIS");
  const snap = SG.state.snap;
  if (!snap) { progressEnd(); return; }

  // The server decides what is in scope - newest commits, most recently
  // touched branches, both capped by the run limits. Asking it rather than
  // working it out again here is what keeps the thing that was priced and the
  // thing that runs the same list.
  let targets;
  try {
    targets = await SG.api("/api/targets");
  } catch (err) {
    sysLine("err", "✕ could not work out what to run on: " + err.message);
    progressEnd();
    return;
  }
  const commitIds = targets.commits || [];
  const branchNames = targets.branches || [];

  const commitBatches = wantCommits ? Math.ceil(commitIds.length / 40) : 0;
  const branchBatches = wantDescribe ? Math.ceil(branchNames.length / 30) : 0;
  const reviews = wantReview ? branchNames.length : 0;
  progressStart(commitBatches + branchBatches + reviews);

  if (wantCommits) {
    const todo = commitIds;
    const size = 40;
    for (let i = 0; i < todo.length; i += size) {
      if (runStopped()) break;          // checked before spending, not after
      const batch = todo.slice(i, i + size);
      const upto = Math.min(i + size, todo.length);
      progressLabel(`explaining commits ${i + 1}-${upto} of ${todo.length}`);
      sysLine("sys", `» explaining commits ${i + 1}-${upto} of ${todo.length}`);
      const res = await explainStream("commits", batch, { onTick: progressTick });
      progressDone();
      if (runStopped()) break;
      if (res.error) { sysLine("err", "  " + res.error); break; }
      sysLine("ok", `  ${res.generated} written, ${res.fromCache} already known`);
    }
  }

  if (wantDescribe && !runStopped()) {
    // Two different things, and the run used to do only the second. The long
    // review answers "what is this branch doing and can it merge"; the one
    // line is what the branch list and the branch page actually display. Skip
    // the one-liners and every branch comes out of a full run with no
    // description at all, which is what a full run is for.
    const names = branchNames;
    const size = 30;
    for (let i = 0; i < names.length; i += size) {
      if (runStopped()) break;
      const batch = names.slice(i, i + size);
      const upto = Math.min(i + size, names.length);
      progressLabel(`describing branches ${i + 1}-${upto} of ${names.length}`);
      sysLine("sys", `» describing branches ${i + 1}-${upto} of ${names.length}`);
      const res = await explainStream("branches", batch, { onTick: progressTick });
      progressDone();
      if (runStopped()) break;
      if (res.error) { sysLine("err", "  " + res.error); break; }
      sysLine("ok", `  ${res.generated} written, ${res.fromCache} already known`);
    }

  }

  if (wantReview && !runStopped()) {
    let n = 0;
    for (const name of branchNames) {
      if (runStopped()) break;
      const label = SG.shortRef(name);
      progressLabel(`reviewing ${label} (${++n} of ${branchNames.length})`);
      sysLine("sys", `» analysing ${label}`);
      await analyseBranchOnce(name);
      progressDone();
      if (runStopped()) break;
    }
  }

  const bill = progressCost();
  const halted = progress && progress.cancelled;
  progressEnd();
  sysLine("ok", halted
    ? `■ stopped · $${bill.spent.toFixed(4)} spent. Everything written is saved; run again to pick up where this left off.`
    : `✓ finished · $${bill.spent.toFixed(4)}`);
  await SG.load(true);
}

// ------------------------------------------------------------- run progress
let progress = null;
// How to let go of the call in flight. Set by whichever stream is open.
let abortCurrent = null;

/** True once the run has been stopped, or when there is no run. */
const runStopped = () => !progress || progress.cancelled;

/** Stop a run part way through.
 *
 *  The call already in flight is let go of rather than killed: it has been
 *  made and will be billed whatever we do, and the server finishes reading it
 *  and saves the result. So stopping costs you the call in progress and
 *  nothing after it, and nothing already written is lost.
 */
function stopRun() {
  if (!progress || progress.cancelled) return;
  progress.cancelled = true;
  progress.label = "stopping after the call in flight";
  paintProgress();
  sysLine("sys", "■ stopping. The call already running is still saved.");
  if (abortCurrent) abortCurrent();
}

function progressStart(total) {
  progress = { done: 0, total: Math.max(1, total), label: "starting",
               t0: Date.now(), tokens: 0, tool: "",
               // Billed so far, and the tokens those calls covered. The two
               // together give a price per token measured from this run
               // itself, which is what prices the call in flight.
               spent: 0, billedTokens: 0 };
  SG.el.oracle.classList.add("busy");
  SG.el.oracleStop.hidden = false;
  // Repainted on a timer as well as on events, so the clock keeps moving
  // through the long silences while a model is thinking.
  progress.timer = setInterval(paintProgress, 1000);
  paintProgress();
}

function progressLabel(text) {
  if (!progress) return;
  progress.label = text;
  progress.tokens = 0;
  progress.tool = "";
  paintProgress();
}

/** Live from inside the call in flight: tokens so far, tool in use. */
function progressTick(info) {
  if (!progress) return;
  if (info.tokens) progress.tokens = info.tokens;
  if (info.tool) progress.tool = info.tool;
  paintProgress();
}

function progressDone() {
  if (!progress) return;
  progress.done++;
  paintProgress();
}

/** Record what a finished call actually cost. */
function progressBill(info) {
  if (!progress || !info) return;
  progress.spent += info.costUsd || 0;
  progress.billedTokens += (info.usage || {}).total || 0;
  paintProgress();
}

/** What the run has cost, including a guess at the call in flight.
 *
 *  The rate comes from the calls this run has already paid for, so it needs no
 *  price table and cannot go stale when prices change. Until the first call
 *  lands there is nothing to derive a rate from, and the estimate is simply
 *  what has been billed - which is zero, honestly.
 */
function progressCost() {
  const p = progress;
  if (!p) return { spent: 0, estimate: 0, rated: false };
  const rate = p.billedTokens > 0 ? p.spent / p.billedTokens : 0;
  const inflight = rate > 0 ? rate * (p.tokens || 0) : 0;
  return { spent: p.spent, estimate: p.spent + inflight, rated: rate > 0 };
}

function progressEnd() {
  if (progress && progress.timer) clearInterval(progress.timer);
  progress = null;
  abortCurrent = null;
  SG.el.oracleStop.hidden = true;
  SG.el.oracle.classList.remove("busy");
  SG.el.oracleBar.firstElementChild.style.width = "100%";
  const live = $("oracleLive");
  if (live) live.remove();
}

const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function paintProgress() {
  const p = progress;
  if (!p) return;
  const pct = Math.min(100, Math.round((p.done / p.total) * 100));
  SG.el.oracleBar.firstElementChild.style.width = pct + "%";
  SG.el.oracleTitle.textContent =
    `CLAUDE: ${p.label} · ${p.done}/${p.total} · ${clock(Date.now() - p.t0)}`;
  // One line that rewrites itself, rather than a log that scrolls away: this
  // is the thing you watch to know it is still moving.
  let live = $("oracleLive");
  if (!live) {
    live = document.createElement("span");
    live.id = "oracleLive";
    live.className = "live";
    SG.el.oracleOut.insertBefore(live, SG.el.oracleOut.firstChild);
  }
  const money = progressCost();
  const bits = [`${pct}%`, clock(Date.now() - p.t0)];
  if (p.tokens) bits.push(`${SG.num(p.tokens)} tokens`);
  // "~" while the figure includes a call that has not been billed yet.
  if (money.estimate > 0) {
    bits.push(money.estimate > money.spent
      ? `~$${money.estimate.toFixed(4)}`
      : `$${money.spent.toFixed(4)}`);
  }
  if (p.tool) bits.push(p.tool);
  live.textContent = `◆ ${p.label} · ${bits.join(" · ")}\n`;

  // The header's usage slot belongs to the run while one is going, rather than
  // to whichever single call happened to finish last.
  SG.el.oracleUsage.textContent = money.estimate > 0
    ? `${money.estimate > money.spent ? "~" : ""}$${money.estimate.toFixed(4)} so far`
    : "";
}

/** One branch analysis, resolving when the stream closes. */
function analyseBranchOnce(name) {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/oracle/branch?name=${encodeURIComponent(name)}`);
    let text = "";
    const letGo = () => { es.close(); if (abortCurrent === letGo) abortCurrent = null; resolve(); };
    abortCurrent = letGo;
    es.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      // The reviews are the slow half - one call per branch - so they report
      // as they write, not only when they finish.
      if (msg.type === "text") {
        text += msg.text;
        progressTick({ tool: `writing, ${SG.num(text.length)} chars` });
      } else if (msg.type === "tool") progressTick({ tool: msg.name });
      else if (msg.type === "usage") progressTick({ tokens: (msg.usage || {}).total });
      else if (msg.type === "result") { showUsage(msg); progressBill(msg); }
      else if (msg.type === "error") sysLine("err", "  " + msg.message);
      else if (msg.type === "done") {
        es.close();
        if (abortCurrent === letGo) abortCurrent = null;
        if (text) sysLine("ok", "  " + text.split("\n")[0].slice(0, 90));
        resolve();
      }
    };
    es.onerror = () => { es.close(); resolve(); };
  });
}

/** Run an explanation over SSE, reporting tokens on the button as they go. */
function explainStream(kind, ids, opts) {
  return new Promise((resolve) => {
    const { button, force, onSummary, onTick } = opts || {};
    const idle = button ? button.textContent : "";
    const url = `/api/explain/stream?kind=${kind}&ids=${ids.map(encodeURIComponent).join(",")}` +
                (force ? "&force=1" : "");
    const es = new EventSource(url);
    let tokens = 0, tool = "";
    if (button) { button.disabled = true; button.classList.add("working"); }

    const paint = () => {
      if (!button) return;
      button.textContent = tokens
        ? `CLAUDE IS READING… ${SG.num(tokens)} TOKENS${tool ? " · " + tool : ""}`
        : "ASKING CLAUDE…";
    };
    paint();

    const finish = (result) => {
      es.close();
      if (abortCurrent === letGo) abortCurrent = null;
      if (button) { button.disabled = false; button.classList.remove("working"); }
      resolve(result || { summaries: {} });
    };
    // Stopping hands the call back rather than killing it: the server keeps
    // reading and saves what it gets, so the batch is not wasted.
    const letGo = () => finish({ summaries: {}, stopped: true });
    abortCurrent = letGo;

    es.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "usage") {
        tokens = (msg.usage || {}).total || tokens;
        paint(); if (onTick) onTick({ tokens });
      } else if (msg.type === "tool") {
        tool = msg.name;
        paint(); if (onTick) onTick({ tool });
      }
      else if (msg.type === "done") {
        for (const [id, text] of Object.entries(msg.summaries || {})) {
          // Commits are keyed by SHA, branches by name under a prefix - the
          // same split the server makes, so the two cannot collide here
          // either.
          SG.state.explains.set(kind === "branches" ? "branch:" + id : id, text);
          if (onSummary) onSummary(id, text);
        }
        if (msg.generated) showExplainCost(msg);
        progressBill(msg);
        finish(msg);
      }
    };
    es.onerror = () => { if (button) button.textContent = idle; finish(null); };
  });
}

/** model · tokens · cost · seconds, from whatever the call reported. One
 *  builder, because three copies of this once disagreed on the rules. */
function usageBits(info) {
  const u = info.usage || {};
  return [
    info.model,
    u.total ? `${SG.num(u.total)} tokens` : null,
    info.costUsd != null ? `$${info.costUsd.toFixed(4)}` : null,
    info.durationMs ? `${(info.durationMs / 1000).toFixed(1)}s` : null,
  ].filter(Boolean);
}

const usageDetail = (u) => u && u.total
  ? `input ${SG.num(u.input)} · output ${SG.num(u.output)} · ` +
    `cache read ${SG.num(u.cacheRead)} · cache write ${SG.num(u.cacheWrite)}`
  : "";

function costLine(info) {
  if (!info) return "";
  const bits = usageBits(info);
  if (!bits.length) return "";
  return `<div class="costline" title="${usageDetail(info.usage)}">${SG.esc(bits.join(" · "))}</div>`;
}

async function explainCommits(branchName) {
  const btn = $("explainBtn");
  const d = SG.state.branchDetail;
  if (!btn || !d) return;
  const ids = (d.commits || []).slice(0, 40)
    .map(c => c.sha).filter(sha => !SG.state.explains.has(sha) &&
      !(d.commits.find(x => x.sha === sha) || {}).summary);
  if (!ids.length) { btn.textContent = "ALL COMMITS EXPLAINED"; return; }

  const res = await explainStream("commits", ids, {
    button: btn,
    onSummary: (sha, text) => {
      const row = (SG.state.branchDetail?.commits || []).find(x => x.sha === sha);
      if (row) row.summary = text;
    },
  });
  SG.renderCommitList();
  btn.textContent = res.error ? "EXPLAIN FAILED, RETRY" : "EXPLAIN AGAIN";

  // The branch itself gets one too, in the same style.
  const bres = await explainStream("branches", [branchName], {});
  const bsum = (bres.summaries || {})[branchName];
  if (bsum) {
    const host = $("branchDesc");
    if (host) { host.textContent = bsum; host.classList.remove("hidden"); }
  }
}

async function explainOneCommit(sha, force) {
  const btn = $("explainOne");
  if (!btn) return;
  const res = await explainStream("commits", [sha], { button: btn, force });
  const text = (res.summaries || {})[sha];
  const host = $("commitDesc");
  if (text && host) { host.textContent = text; host.classList.remove("hidden"); }
  const row = (SG.state.branchDetail?.commits || []).find(x => x.sha === sha);
  if (row && text) row.summary = text;
  const cost = $("commitCost");
  // Fill the slot rather than replacing the node: an empty cost line must not
  // delete the place the next one goes.
  if (cost && res.generated) cost.innerHTML = costLine(res);
  btn.textContent = res.error ? "EXPLAIN FAILED, RETRY" : "EXPLAIN AGAIN";
}

function showExplainCost(res) {
  const bits = usageBits({ ...res, durationMs: null });
  if (res.fromCache) bits.push(`${res.fromCache} reused`);
  SG.el.oracleUsage.textContent = bits.join(" · ");
}

// -------------------------------------------------------------- output pane
function oracleReset(title) {
  SG.el.oracle.classList.remove("collapsed", "error");
  SG.el.oracle.classList.add("busy");
  SG.el.oracleToggle.textContent = "▼";
  SG.el.oracleTitle.textContent = title;
  SG.el.oracleUsage.textContent = "";
  SG.el.oracleOut.innerHTML = "";
  SG.view.resize();
}

function closeStream() {
  if (SG.state.stream) { SG.state.stream.close(); SG.state.stream = null; }
}

let buffer = "", pending = false;

function flush() {
  pending = false;
  SG.el.oracleOut.innerHTML =
    SG.markLabels(SG.esc(buffer)) + '<span class="cursor"></span>';
  SG.el.oracleOut.scrollTop = SG.el.oracleOut.scrollHeight;
}

function append(text) {
  buffer += text;
  if (!pending) { pending = true; requestAnimationFrame(flush); }
}

/** Put a complete, saved answer in the pane, with no cursor left blinking. */
function showAnswer(text) {
  buffer = text;
  flush();
  SG.el.oracleOut.querySelector(".cursor")?.remove();
}

function sysLine(cls, text) {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text + "\n";
  SG.el.oracleOut.insertBefore(span, SG.el.oracleOut.firstChild);
}

/** Full disclosure of what a Claude call cost. */
function showUsage(info) {
  const bits = usageBits(info);
  if (info.cached) bits.push("saved answer");
  SG.el.oracleUsage.title = usageDetail(info.usage);
  SG.el.oracleUsage.textContent = bits.join(" · ");
}

function openStream(url, title, force) {
  closeStream();
  oracleReset(title);
  buffer = "";
  SG.state.lastStream = { url, title };
  SG.el.oracleRerun.hidden = false;
  const es = new EventSource(url + (force ? (url.includes("?") ? "&" : "?") + "force=1" : ""));
  SG.state.stream = es;
  let model = SG.state.snap?.repo?.model;

  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "status":
        if (msg.model) model = msg.model;
        sysLine("sys", "» " + msg.message);
        break;
      case "tool":  sysLine("tool", "  ↳ " + msg.name + (msg.input ? "  " + msg.input : "")); break;
      case "merge": renderMergeFacts(msg.data); break;
      case "cached":
        sysLine("sys", msg.partial
          ? `» saved answer from ${SG.when(msg.at)} (${SG.ago(msg.at)}), cut short when the
             page was closed. Click ASK AGAIN for a complete one`
          : `» saved answer from ${SG.when(msg.at)} (${SG.ago(msg.at)}). Click ASK AGAIN for a new one`);
        showUsage({ model: msg.model, cached: true });
        break;
      case "text":  append(msg.text); break;
      case "result":
        if (!buffer && msg.text) append(msg.text);
        showUsage({ ...msg, model: msg.model || model });
        break;
      case "error":
        SG.el.oracle.classList.add("error");
        sysLine("err", "✕ " + msg.message);
        break;
      case "done":
        es.close(); SG.state.stream = null;
        SG.el.oracle.classList.remove("busy");
        SG.el.oracleTitle.textContent = title + " (done)";
        flush();
        SG.el.oracleOut.querySelector(".cursor")?.remove();
        break;
    }
  };
  es.onerror = () => {
    if (SG.state.stream !== es) return;
    es.close(); SG.state.stream = null;
    SG.el.oracle.classList.remove("busy");
    if (!buffer) { SG.el.oracle.classList.add("error"); sysLine("err", "✕ connection lost"); }
  };
}

function renderMergeFacts(m) {
  if (!m.ok) { sysLine("err", "✕ merge test failed: " + m.error); return; }
  if (m.clean) sysLine("ok", "✓ git test merge: no conflicts");
  else {
    sysLine("warn", `⚠ git test merge: ${m.conflicts.length} file(s) conflict`);
    for (const f of m.conflicts) sysLine("warn", "    " + f);
  }
}

const runOracleBranch = (name, force) =>
  openStream(`/api/oracle/branch?name=${encodeURIComponent(name)}`,
             `CLAUDE: ${SG.shortRef(name)}`, force);

const runOracleMerge = (force) => {
  if (!SG.state.a || !SG.state.b) return;
  openStream(`/api/oracle/merge?a=${encodeURIComponent(SG.state.a)}&b=${encodeURIComponent(SG.state.b)}`,
             `CLAUDE: ${SG.shortRef(SG.state.a)} ← ${SG.shortRef(SG.state.b)}`, force);
};

SG.explainStream = explainStream;
SG.costLine = costLine;
SG.explainCommits = explainCommits;
SG.oracleReset = oracleReset;
SG.closeStream = closeStream;
SG.showAnswer = showAnswer;
SG.sysLine = sysLine;
SG.showUsage = showUsage;
SG.openStream = openStream;
SG.runOracleBranch = runOracleBranch;
SG.runOracleMerge = runOracleMerge;
SG.runFullAnalysis = runFullAnalysis;
SG.stopRun = stopRun;
SG.explainOneCommit = explainOneCommit;
})();
