/* Shared state and helpers.
 *
 * Everything the other files need in common lives here, on one namespace. They
 * load in order: core, claude, panels, dialogs, app.
 */
(() => {
"use strict";
// One namespace shared by every file, bound explicitly rather than relying on
// a bare identifier resolving against the global object.
const SG = (window.SG = window.SG || {});
const $ = (id) => document.getElementById(id);


const el = {
  meter: $("meter"), meterLabel: $("meterLabel"), fieldGlyph: $("fieldGlyph"),
  fieldName: $("fieldName"), meterTarget: $("meterTarget"), repoName: $("repoName"),
  metaMain: $("metaMain"), metaBranches: $("metaBranches"), metaCommits: $("metaCommits"),
  metaCache: $("metaCache"), daysInput: $("daysInput"),
  branchList: $("branchList"), refreshBtn: $("refreshBtn"),
  filterInput: $("filterInput"), filterCount: $("filterCount"),
  filterClear: $("filterClear"),
  aiToggle: $("aiToggle"), aiCount: $("aiCount"),
  slotA: $("slotA"), slotB: $("slotB"), pairReadout: $("pairReadout"),
  analyzeBtn: $("analyzeBtn"), worktreeBtn: $("worktreeBtn"),
  canvas: $("canvas"), tooltip: $("tooltip"), loading: $("loading"),
  canvasHint: $("canvasHint"),
  inspector: $("inspector"), inspectorBody: $("inspectorBody"), inspectorClose: $("inspectorClose"),
  oracle: $("oracle"), oracleOut: $("oracleOut"), oracleTitle: $("oracleTitle"),
  oracleToggle: $("oracleToggle"), oracleUsage: $("oracleUsage"), oracleRerun: $("oracleRerun"),
  oracleBar: $("oracleBar"), oracleStop: $("oracleStop"),
  modal: $("modal"), modalTitle: $("modalTitle"), modalBody: $("modalBody"),
  modalOk: $("modalOk"), modalCancel: $("modalCancel"), modalX: $("modalX"),
  modalActions: $("modalActions"), upaBtn: $("upaBtn"),
};

const state = {
  snap: null, byName: new Map(),
  a: null, b: null, focus: null,
  pairReading: null, stream: null, lastStream: null,
  branchDetail: null,
  sort: { by: "date", dir: "desc" },
  filterRe: null,                // the compiled branch filter
  explains: new Map(),           // sha -> one-line Claude summary (session cache)
};

// ------------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const shortRef = (n) => {
  if (!n) return "";
  const b = state.byName.get(n);
  return (b && b.label) || n.replace(/^(origin|upstream)\//, "");
};

const ago = (ts) => {
  if (!ts) return "";
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 60) return `${Math.round(d / 86400)} d ago`;
  return `${Math.round(d / 86400 / 30)} mo ago`;
};

const num = (n) => (n || 0).toLocaleString("en-US");

/** An absolute local date and time. "3 d ago" tells you how stale an answer
 *  is; this tells you which run it came from, which is what you need when you
 *  are deciding whether it predates the work you just did. */
const when = (ts) => {
  if (!ts) return "";
  const d = new Date(ts * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Mirrors ATTRACTOR_FIELDS in divergence.py. Kept here so a per-commit score
// does not have to carry its level name across the wire 1800 times.
const LEVELS = [
  [0.00, "alpha", "\u03b1"], [0.25, "beta", "\u03b2"], [0.50, "gamma", "\u03b3"],
  [0.75, "delta", "\u03b4"], [1.00, "epsilon", "\u03b5"], [1.25, "zeta", "\u03b6"],
  [1.50, "eta", "\u03b7"],
];

function levelFor(value) {
  let hit = LEVELS[0];
  for (const row of LEVELS) if (value >= row[0]) hit = row;
  return { lower: hit[0], name: hit[1], glyph: hit[2] };
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: "bad response" }));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Mark the section labels a Claude answer is asked to write. One regex,
// because the two places that render answers once drifted apart on it.
const markLabels = (escapedText) => escapedText.replace(
  /^(VERDICT|COLLISION|ORDER|BLAST RADIUS|PET PEEVE|INTENT|STATE|RISK):/gm,
  '<span class="lbl">$1:</span>');

// ---------------------------------------------------------------------- boot

const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

SG.el = el;
SG.state = state;
SG.esc = esc;
SG.shortRef = shortRef;
SG.ago = ago;
SG.num = num;
SG.when = when;
SG.levelFor = levelFor;
SG.api = api;
SG.post = post;
SG.markLabels = markLabels;
SG.kv = kv;
})();
