/* Entry point: load the repository, wire the canvas, keep selection in step. */
(() => {
"use strict";
const SG = window.SG;

let view = null;

// ---------------------------------------------------------------------- boot
async function boot() {
  Meter.mount(SG.el.meter);
  view = Renderer.create(SG.el.canvas, { onHover, onPick, onPin });
  SG.view = view;
  wireUi();
  await load();
  SG.maybeOfferFullRun();
}

async function load(force) {
  SG.el.loading.classList.remove("hidden");
  SG.el.loading.textContent = force ? "READING THE REPOSITORY AGAIN…" : "READING THE REPOSITORY…";
  try {
    const snap = await SG.api("/api/state" + (force ? "?refresh=1" : ""));
    SG.state.snap = snap;
    SG.state.byName = new Map(snap.branches.map(b => [b.name, b]));
    view.setData(snap.graph, snap.branches, snap.repo.main);
    renderMeta();
    renderBranchList();
    applyFilter();               // a reload must not quietly drop the filter
    const ai = snap.graph.commits.filter(c => c.ai).length;
    SG.el.aiCount.textContent = ai ? `${ai}/${snap.graph.commits.length}` : "none";
    view.setAiHighlight(SG.el.aiToggle.checked);
    for (const k of ["a", "b", "focus"]) {
      if (SG.state[k] && !SG.state.byName.has(SG.state[k])) SG.state[k] = null;
    }
    syncSelection();
    view.fit(false);
    if (!snap.graph.commits.length) {
      SG.el.loading.textContent = snap.repo.days
        ? `NO COMMITS IN THE LAST ${snap.repo.days} DAYS. INCREASE THE DAYS VALUE`
        : "THIS REPOSITORY HAS NO COMMITS";
      return;
    }
  } catch (err) {
    SG.el.loading.textContent = "ERROR: " + err.message;
    return;
  }
  SG.el.loading.classList.add("hidden");
}

function renderMeta() {
  const r = SG.state.snap.repo;
  SG.el.repoName.textContent = `${r.name} · ${r.path}`;
  SG.el.metaMain.textContent = r.mainLabel || r.main;
  SG.el.metaBranches.textContent = r.branchCount;
  SG.el.metaCommits.textContent = `${r.commitCount} · ${r.scanMs}ms`;
  const kb = r.cache || {};
  if (kb.enabled) {
    const rows = Object.values(kb.kinds || {}).reduce((n, k) => n + k.rows, 0);
    SG.el.metaCache.textContent = `${rows} · ${Math.round((kb.bytes || 0) / 1024)}KB${r.fromCache ? " ✓" : ""}`;
    SG.el.metaCache.title = r.fromCache
      ? "Nothing changed. We reused the saved data."
      : "We saved this scan for next time.";
  } else { SG.el.metaCache.textContent = "off"; }
  if (document.activeElement !== SG.el.daysInput) SG.el.daysInput.value = r.days ?? 0;
  document.title = `STEINS;GIT: ${r.name}`;
}

// -------------------------------------------------------------- branch rail
function renderBranchList() {
  const frag = document.createDocumentFragment();
  for (const b of SG.state.snap.branches) {
    const color = view.heatCss(b.divergence, b.isMain);
    const node = document.createElement("div");
    node.className = "bitem" + (b.isMain ? " main" : "");
    node.style.setProperty("--c", color);
    node.dataset.name = b.name;
    node.dataset.idx = String(frag.childElementCount);   // the unfiltered order
    node.title = b.name;
    node.innerHTML = `
      <div class="row1">
        <span class="nm">${SG.esc(b.label || b.name)}</span>
        <span class="dv">${b.display}</span>
      </div>
      <div class="row2">
        ${b.isMain ? '<span>default branch</span>'
          : `<span>${b.ahead} ahead · ${b.behind} behind</span>
             <span>${Math.round(b.conflictRisk * 100)}% overlap</span>`}
        ${b.isHead ? '<span class="pill head">HEAD</span>' : ""}
        ${b.remote ? '<span class="pill remote">remote</span>' : ""}
      </div>`;
    node.classList.toggle("faded", !matchesFilter(b));
    node.addEventListener("click", () => toggleBranch(b.name));
    node.addEventListener("mouseenter", () => view.setSelection({ hoverBranch: b.name }));
    node.addEventListener("mouseleave", () => view.setSelection({ hoverBranch: null }));
    frag.appendChild(node);
  }
  SG.el.branchList.replaceChildren(frag);
}

// -------------------------------------------------------------------- filter

/** Compile what is in the box. An unfinished regex is not an error worth
 *  shouting about - you are still typing - so we just mark the box and leave
 *  the last good filter in place until it parses again. */
function compileFilter(source) {
  if (!source) return { re: null, ok: true };
  try { return { re: new RegExp(source, "i"), ok: true }; }
  catch (err) { return { re: null, ok: false, message: err.message }; }
}

function matchesFilter(b) {
  return !SG.state.filterRe || b.isMain ||
         SG.state.filterRe.test(b.name) ||
         (!!b.label && SG.state.filterRe.test(b.label));
}

/** Push the current filter into the canvas and the rail.
 *
 *  Nothing is removed. Branches that do not match keep their column and their
 *  commits; they thin out, lose their name plate, and hand most of their
 *  width to the ones that do, which the renderer animates rather than snaps.
 */
function applyFilter() {
  const source = SG.el.filterInput.value.trim();
  const { re, ok, message } = compileFilter(source);
  SG.el.filterInput.classList.toggle("bad", !ok);
  SG.el.filterInput.title = ok ? "" : "not a valid regex: " + message;
  if (!ok) return;                       // keep showing the last good filter

  SG.state.filterRe = re;
  const kept = view.setFilter(re);
  SG.el.filterClear.hidden = !source;

  const total = SG.state.snap
    ? SG.state.snap.branches.filter(b => !b.isMain).length : 0;
  SG.el.filterCount.textContent = source ? `${kept}/${total}` : "";

  // Matches move to the top of the rail. Looking for a branch and then having
  // to hunt down a list for it is the thing the filter was meant to stop, and
  // the canvas has already put them in front - the list should agree.
  // Order within each group is left alone, so nothing jumps about beyond the
  // one move, and clearing the filter puts the original order back.
  const list = SG.el.branchList;
  const hit = [], miss = [];
  for (const node of list.children) {
    const b = SG.state.byName.get(node.dataset.name);
    const on = !b || matchesFilter(b);
    node.classList.toggle("faded", !on);
    (on ? hit : miss).push(node);
  }
  const order = source
    ? [...hit, ...miss]
    : [...list.children].sort((m, n) => m.dataset.idx - n.dataset.idx);
  // Only touch the DOM if the order actually differs; append() on an already
  // correct list still moves every node.
  if (order.some((node, i) => list.children[i] !== node)) list.append(...order);
}

// ----------------------------------------------------------------- selection
function toggleBranch(name) {
  if (SG.state.a === name) SG.state.a = null;
  else if (SG.state.b === name) SG.state.b = null;
  else if (!SG.state.a) SG.state.a = name;
  else if (!SG.state.b) SG.state.b = name;
  else { SG.state.a = SG.state.b; SG.state.b = name; }
  SG.state.focus = name;
  syncSelection();
  SG.showBranch(name);
}

function syncSelection() {
  view.setSelection({ a: SG.state.a, b: SG.state.b, focus: SG.state.focus });
  for (const node of SG.el.branchList.children) {
    const n = node.dataset.name;
    node.classList.toggle("sel", n === SG.state.a || n === SG.state.b);
    node.querySelector(".abadge")?.remove();
    if (n === SG.state.a || n === SG.state.b) {
      const badge = document.createElement("div");
      badge.className = "abadge";
      badge.textContent = n === SG.state.a ? "A" : "B";
      node.appendChild(badge);
    }
  }
  fillSlot(SG.el.slotA, SG.state.a);
  fillSlot(SG.el.slotB, SG.state.b);

  const pair = SG.state.a && SG.state.b;
  SG.el.analyzeBtn.disabled = !pair;
  SG.el.worktreeBtn.disabled = !pair;

  if (pair) loadPair();
  else {
    SG.state.pairReading = null;
    SG.el.pairReadout.textContent = SG.state.a
      ? "Now click a second branch."
      : "Click two branches to compare them.";
    const b = SG.state.focus && SG.state.byName.get(SG.state.focus);
    if (b) setMeter("BRANCH DIVERGENCE", b.display, b.field,
                    `${b.label} vs ${SG.state.snap.repo.mainLabel}`);
    else setMeter("DIVERGENCE", "0.000000", { glyph: "θ", name: "reference" }, "select a branch");
  }
}

function fillSlot(slot, name) {
  const b = name && SG.state.byName.get(name);
  slot.classList.toggle("filled", !!b);
  slot.title = name || "";
  slot.querySelector(".nm").textContent = (b && b.label) || name || "-";
  slot.style.setProperty("--c", b ? view.heatCss(b.divergence, b.isMain) : "");
}

async function loadPair() {
  SG.el.pairReadout.textContent = "Measuring…";
  // The meter spins while the measurement is in flight, rather than sitting
  // on the previous pair's number as though it applied.
  SG.el.meterLabel.textContent = "DIFFERENCE A ↔ B";
  Meter.spin();
  try {
    const cmp = await SG.api(`/api/compare?a=${encodeURIComponent(SG.state.a)}&b=${encodeURIComponent(SG.state.b)}`);
    SG.state.pairReading = cmp;
    setMeter("DIFFERENCE A ↔ B", cmp.reading.display, cmp.reading.field,
             `${cmp.bLabel} vs ${cmp.aLabel}`);
    const m = cmp.merge;
    const verdict = !m.ok ? `<span class="bad">The merge test failed.</span>`
      : m.clean ? `<span class="good">✓ These branches merge cleanly.</span>`
      : `<span class="bad">✕ ${m.conflicts.length} file(s) conflict.</span>`;
    // Old git cannot do the merge in memory, so we do it ourselves on a
    // scratch index. Same answer except for renames, and saying so is cheaper
    // than having somebody trust a conflict that git would have resolved.
    const caveat = m.engine === "merge-file"
      ? `<br><span class="sm warn">Merged on a scratch index: your git is older
           than 2.38. Renames are not followed, so a renamed-and-edited file
           shows here as a conflict.</span>`
      : "";
    SG.el.pairReadout.innerHTML =
      `${verdict}<br><span class="sm">${SG.esc(cmp.explain)}</span>${caveat}`;
  } catch (err) {
    SG.el.pairReadout.innerHTML = `<span class="bad">${SG.esc(err.message)}</span>`;
  }
}

function setMeter(label, display, field, target) {
  SG.el.meterLabel.textContent = label;
  Meter.set(display);
  SG.el.fieldGlyph.textContent = field.glyph || "θ";
  SG.el.fieldName.textContent = (field.name || "").toUpperCase();
  SG.el.meterTarget.textContent = target;
  SG.el.meterTarget.title = field.flavour || "";
}

// ------------------------------------------------------------------- canvas

// The canvas rectangle, re-read only when its size can have changed, because
// hover runs on every pointer move and getBoundingClientRect forces layout.
let canvasBox = null;
const canvasRect = () =>
  canvasBox || (canvasBox = SG.el.canvas.getBoundingClientRect());
new ResizeObserver(() => { canvasBox = null; }).observe(SG.el.canvas);

function onHover(hit, pos) {
  if (!hit) { SG.el.tooltip.classList.add("hidden"); return; }
  const t = SG.el.tooltip;
  if (hit.type === "commit") {
    const c = hit.commit, i = c.impact || {};
    t.style.setProperty("--c", view.colorOf(c.branch));
    t.dataset.sha = c.sha;
    const known = SG.state.explains.get(c.sha);
    // The branch goes first, not last. Zoomed far enough out that the name
    // plates are gone, this is the only thing on screen that says where you
    // are, and reading it off the bottom line of a tooltip is no good.
    t.innerHTML =
      `<div class="t-branch">${SG.esc(SG.shortRef(c.branch))}</div>
       <div class="t-sub">${SG.esc(c.subject)}</div>
       ${known ? `<div class="t-why">${SG.esc(known)}</div>` : ""}
       <div class="t-meta">${c.short} · ${SG.esc(c.author)} · ${SG.ago(c.ts)}${c.merge ? " · merge" : ""}</div>
       <div class="t-dv">change size ${i.display || "-"} · +${i.insertions || 0}/-${i.deletions || 0} in ${i.files || 0} file(s)</div>
       ${c.ai ? `<div class="t-ai">co-authored with ${SG.esc(c.aiWith || "a model")}</div>` : ""}`;
    if (known === undefined) fetchSummary(c.sha);
  } else {
    const b = SG.state.byName.get(hit.branch);
    if (!b) { t.classList.add("hidden"); return; }
    t.style.setProperty("--c", view.heatCss(b.divergence, b.isMain));
    t.dataset.sha = "";
    t.innerHTML =
      `<div class="t-sub">${SG.esc(b.label || b.name)}</div>
       <div class="t-meta">${SG.esc(b.summary)}</div>
       <div class="t-dv">divergence ${b.display} · ${SG.esc(b.field.name)}</div>`;
  }
  t.classList.remove("hidden");
  const wrap = canvasRect();
  t.style.left = Math.min(pos.x + 16, wrap.width - t.offsetWidth - 8) + "px";
  t.style.top = Math.max(6, Math.min(pos.y + 16, wrap.height - t.offsetHeight - 8)) + "px";
}

/** Pull a saved explanation for a commit and drop it into the live tooltip.
 *
 *  Summaries are not carried in the graph payload, which would add a sentence
 *  per commit to every response. They are fetched once per commit and kept.
 */
async function fetchSummary(sha) {
  SG.state.explains.set(sha, null);          // in flight, do not ask twice
  let text = null;
  try {
    const d = await SG.api(`/api/commit?sha=${encodeURIComponent(sha)}`);
    text = d.summary || null;
    SG.state.explains.set(sha, text);
  } catch {
    // A failed request is not "known to have no summary": forget it, so the
    // next hover asks again instead of never showing one.
    SG.state.explains.delete(sha);
  }
  if (!text) return;
  const t = SG.el.tooltip;
  if (t.dataset.sha !== sha || t.classList.contains("hidden")) return;
  const sub = t.querySelector(".t-sub");
  if (!sub || t.querySelector(".t-why")) return;
  const why = document.createElement("div");
  why.className = "t-why";
  why.textContent = text;
  sub.after(why);
}

// The hint line doubles as the status line for a pinned branch, so its
// original wording has to be kept to put back afterwards.
const HINT = SG.el.canvasHint.innerHTML;
function resetHint() {
  SG.el.canvasHint.innerHTML = HINT;
  SG.el.canvasHint.classList.remove("loud");
}

/** Double-click: single this branch out and show what it is tied to. */
function onPin(name) {
  if (!name) return;
  SG.state.a = name;
  SG.state.b = null;
  SG.state.focus = name;
  syncSelection();
  const near = view.focusOn(name);
  SG.showBranch(name);
  SG.el.canvasHint.textContent = near > 1
    ? `${SG.shortRef(name)} and the ${near - 1} branch(es) it shares history with. ` +
      "Click empty canvas to come back."
    : `${SG.shortRef(name)} shares history with nothing else in this window. ` +
      "Click empty canvas to come back.";
  SG.el.canvasHint.classList.add("loud");
}

function onPick(hit) {
  // Clicking bare canvas is how you say "never mind". Anything else and the
  // only way out of a selection is the Escape key, which you have to know
  // about first.
  if (!hit) {
    if (!SG.state.a && !SG.state.b && !SG.state.focus) return;
    SG.state.a = SG.state.b = SG.state.focus = null;
    syncSelection();
    SG.el.tooltip.classList.add("hidden");
    resetHint();
    return;
  }
  if (hit.type === "branch") { toggleBranch(hit.branch); return; }
  SG.state.focus = hit.commit.branch;
  view.setSelection({ focus: SG.state.focus });
  const i = hit.commit.impact;
  if (i) setMeter("CHANGE SIZE", i.display, SG.levelFor(i.value), `commit ${hit.commit.short}`);
  SG.showCommit(hit.commit.sha);
}

// ----------------------------------------------------------------------- ui
function wireUi() {
  SG.el.refreshBtn.addEventListener("click", SG.showRescan);
  SG.el.analyzeBtn.addEventListener("click", () => SG.runOracleMerge(false));
  SG.el.worktreeBtn.addEventListener("click", SG.confirmWorktree);
  SG.el.upaBtn.addEventListener("click", () => SG.showHelp("help"));
  SG.el.oracleStop.addEventListener("click", SG.stopRun);
  SG.el.oracleRerun.addEventListener("click", () => {
    if (SG.state.lastStream) SG.openStream(SG.state.lastStream.url, SG.state.lastStream.title, true);
  });
  SG.el.inspectorClose.addEventListener("click", () => {
    SG.el.inspector.classList.add("hidden"); view.resize();
  });
  SG.el.oracleToggle.addEventListener("click", () => {
    SG.el.oracle.classList.toggle("collapsed");
    SG.el.oracleToggle.textContent = SG.el.oracle.classList.contains("collapsed") ? "▲" : "▼";
    view.resize();
  });
  SG.el.modalCancel.addEventListener("click", SG.closeModal);
  SG.el.modalX.addEventListener("click", SG.closeModal);
  SG.el.modal.addEventListener("click", (ev) => { if (ev.target === SG.el.modal) SG.closeModal(); });

  // Filtering is cheap (it only moves weights), so it runs as you type, with
  // just enough delay that a fast typist does not animate every keystroke.
  let filterTimer = null;
  SG.el.filterInput.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 110);
  });
  SG.el.filterInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    if (SG.el.filterInput.value) { SG.el.filterInput.value = ""; applyFilter(); }
    else SG.el.filterInput.blur();
  });
  SG.el.aiToggle.addEventListener("change", () => {
    view.setAiHighlight(SG.el.aiToggle.checked);
  });

  SG.el.filterClear.addEventListener("click", () => {
    SG.el.filterInput.value = "";
    applyFilter();
    SG.el.filterInput.focus();
  });

  SG.el.daysInput.addEventListener("change", async () => {
    const days = parseInt(SG.el.daysInput.value, 10);
    if (Number.isNaN(days)) return;
    SG.el.loading.classList.remove("hidden");
    SG.el.loading.textContent = "READING THE REPOSITORY AGAIN…";
    try {
      await SG.post("/api/window", { days });
      await load();
    } catch (err) { SG.el.loading.textContent = "ERROR: " + err.message; }
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.target.tagName === "INPUT") return;
    if (ev.key === "f") view.fit();
    else if (ev.key === "r") SG.showRescan();
    else if (ev.key === "?" || ev.key === "h") SG.showHelp();
    else if (ev.key === "Escape") {
      if (!SG.el.modal.classList.contains("hidden")) return SG.closeModal();
      SG.state.a = SG.state.b = SG.state.focus = null;
      syncSelection();
      resetHint();
      SG.el.inspector.classList.add("hidden");
      SG.closeStream();
      view.resize();
    }
  });
}


// The renderer is created in boot(), so publish it there rather than here,
// where it would still be null.
SG.load = load;

boot();
})();
