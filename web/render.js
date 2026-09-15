/* Canvas branch renderer.

   Time grows upward: the root of history sits at the bottom, the newest commits
   are the leaves at the top. The default branch is a thick bone-white trunk in
   the centre column; every other branch is a straight vertical line in a free
   column beside it, peeling away on a long cubic curve.

   Geometry note: the two axes are independent. Y is a world-space time scale,
   but X is pure screen space. Each column owns a slab of width `cw` and sits
   in the middle of it, so positions are the running total of the slabs
   outward from the trunk. The trunk keeps a moat either side and stays at the
   centre of the viewport. Filtering does not hide anything: it shrinks the
   slabs of the branches you did not ask for, and those widths are animated,
   so the picture opens out around the matches instead of jumping.

   Colour runs green (converged) through gold to ember (far apart), so the
   picture carries the metric without a legend.

   Performance: no shadowBlur (the most expensive canvas op) - glow is two wider
   low-alpha passes under the real stroke. Everything is culled, hit-testing
   uses a 1-D bucket index over the time axis, and drawing happens on a dirty
   flag inside rAF that sleeps when nothing is moving. */

const Renderer = (() => {

  // Divergence ramp: green = converged and safe, ember = far apart. It runs
  // green through gold to orange and stops there. Red read as an error rather
  // than as a long way from home, which is all a high number means.
  const RAMP = [
    [0.00, [104, 196, 122]],
    [0.28, [162, 204,  92]],
    [0.55, [220, 192,  76]],
    [0.85, [252, 172,  54]],
    [1.20, [255, 140,  34]],
    [1.60, [255, 112,  22]],
  ];
  const MAIN_RGB = [248, 244, 234];
  const BG = "#0a0a09";

  const CELL = 90;           // time-axis bucket size for hit-testing
  const NODE_R = 5.0;
  const PICK_SLOP = 13;
  const DIM = 0.22;
  const EASE_MS = 150;
  const SPAWN_MS = 1500;
  // Floors, not targets. Below these the picture stops being readable, so
  // fitting gives up on showing everything at once and lets you scroll
  // instead - which is the right trade for a repository, where the newest
  // history is what you came to look at.
  const COL_MIN = 118, COL_MAX = 210;   // a name plate needs a column to sit in
  const MIN_GAP_PX = 26;                // closest two commits may ever be drawn
  const MIN_DY_FALLBACK = 38;           // layout's MIN_DY, for a graph without it
  // Singling out a branch must not squeeze the columns below this, however far
  // away the things it is tied to happen to sit.
  const PIN_PITCH = 132;
  // How far a deliberate zoom may travel on each axis. Both are generous;
  // what matters is that the wheel never lets one of them hit a stop on its
  // own - see the joint clamp in the wheel handler.
  const S_MIN = 0.01, S_MAX = 24;
  const CW_MIN = 10, CW_MAX = 2400;
  const PATH_RGB = [255, 214, 130];     // the run of commits joining two branches
  const AI_RGB = [146, 255, 64];        // commits a model had a hand in
  // Clearance on each side of the trunk, in column widths. 1.0 would put the
  // first branch exactly one column out; the extra is a moat, so the default
  // branch reads as the axis of the picture rather than as one line among N.
  const TRUNK_GUTTER = 1.4;
  // What a branch keeps when a filter excludes it. It never disappears: it
  // steps back, thins out, and hands its width to the branches you asked for.
  const FADED_W = 0.26;      // share of a column width, when filtered out
  // Picking a pair is a stronger statement than typing a filter, so the
  // branches it excludes step further back. It also shortens the reach the
  // camera has to cover, which is what lets the two you picked be framed
  // properly instead of pressed against the edges.
  const FOCUS_W = 0.13;
  const FADED_LIT = 0.16;    // share of its normal opacity
  const FILTER_MS = 460;     // how long the picture takes to rearrange
  const GLIDE_MS = 460;      // ordinary camera move
  const REFRAME_MS = 760;    // the longer move onto a filtered set
  // How far out a column sits, in column widths, by how far its branch has
  // diverged. Distance from the trunk then means the same thing the colour
  // already means, so a branch that looks far away is far away.
  const SPREAD_NEAR = 0.78, SPREAD_FAR = 1.9;
  const SPREAD_FULL = 1.6;   // divergence counted as "as far as it goes"

  function heat(v, isMain) {
    if (isMain) return MAIN_RGB;
    v = Math.max(0, Math.min(1.6, v));
    for (let i = 1; i < RAMP.length; i++) {
      if (v <= RAMP[i][0] || i === RAMP.length - 1) {
        const [v0, c0] = RAMP[i - 1], [v1, c1] = RAMP[i];
        const t = v1 === v0 ? 0 : Math.min(1, (v - v0) / (v1 - v0));
        return [0, 1, 2].map(k => Math.round(c0[k] + (c1[k] - c0[k]) * t));
      }
    }
    return MAIN_RGB;
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const css  = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  // Column 0 is the trunk; odd columns sit left of it, even columns right.
  function laneOffset(lane) {
    if (lane <= 0) return 0;
    const step = (lane + 1) >> 1;
    return (lane % 2) ? -step : step;
  }

  function create(canvas, hooks = {}) {
    const ctx = canvas.getContext("2d", { alpha: false });
    // s scales the time axis; cw is the column pitch in screen pixels.
    const cam = { s: 1, cw: 120, tx: 0, ty: 0 };
    let W = 0, H = 0, dpr = 1;

    let graph = { commits: [], edges: [], branches: [], bounds: null };
    let branchInfo = new Map();
    let laneOf = new Map();
    let mainName = null;
    let buckets = new Map();
    let commitBySha = new Map();
    let sortedEdges = [];
    let orderedBranches = [];
    let sel = { a: null, b: null, focus: null, hover: null, hoverBranch: null };

    let lit = new Map();
    // Column geometry. Lanes no longer sit at fixed integer offsets: each one
    // owns a slab of width `laneW`, and positions are the running total of
    // those slabs outward from the trunk. Filtering animates the weights, so
    // the layout breathes instead of jumping.
    let laneOrder = { left: [], right: [] };   // lane indices, nearest first
    let lanePos = new Map();                   // lane -> signed offset in columns
    let laneW = new Map();                     // lane -> current width weight
    let laneTarget = new Map();                // lane -> width it is heading for
    let filterRe = null;
    let showAi = false;          // mark the commits a model helped write
    let match = new Map();                     // branch -> matches the filter
    let pres = new Map();                      // branch -> animated 0..1 presence
    // The commits and edges joining the current selection back to where it
    // last agreed with the other side. Rebuilt whenever the selection moves.
    let path = null;   // {nodes:Set, edges:Set, base:sha, branches:Set, ends:[]}
    let pathKey = null;          // guards against recomputing on every hover
    let focusNames = null;       // branches a two-branch selection is about
    let focusPin = null;         // {name, names} while one branch is pinned
    let branchNeighbours = new Map();   // branch -> branches it forks or merges with
    let spawn = null;                 // {name, t0} while a new branch grows in
    let labelRects = [];              // name plates as drawn, for hit-testing
    let dirty = true, animating = false, lastT = 0;

    /** Node radius carries per-commit change size; draw and pick must agree. */
    function nodeRadius(c) {
      const zoom = Math.min(1.35, Math.max(.7, cam.s * 1.6));
      const rel = (c.impact && c.impact.rel) || 0;
      const shrink = c.branch === mainName ? 1 : 0.4 + 0.6 * presOf(c.branch);
      return NODE_R * zoom * (0.68 + 0.82 * rel) * shrink *
             (c.branch === mainName ? 1.12 : 1);
    }

    const offsetOf = (lane) => lanePos.get(lane) ?? laneOffset(lane);
    const sx = lane => cam.tx + offsetOf(lane) * cam.cw;
    const sy = wy   => cam.ty + wy * cam.s;
    const toWorldY = py => (py - cam.ty) / cam.s;
    const toLaneF  = px => (px - cam.tx) / cam.cw;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      // Opening the inspector or the Claude pane narrows the canvas. Hold
      // whatever was at the centre at the centre, so the trunk - which the
      // layout puts there - stays there instead of sliding out from under the
      // panel that just appeared.
      if (W) cam.tx += (r.width - W) / 2;
      W = r.width; H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      dirty = true;
    }

    function setData(g, branches, main) {
      graph = g;
      mainName = main;
      branchInfo = new Map();
      laneOf = new Map();
      const seen = new Set();
      const lanes = [];
      for (const b of branches) {
        branchInfo.set(b.name, { ...b, color: heat(b.divergence, b.isMain) });
        laneOf.set(b.name, b.lane);
        if (!lit.has(b.name)) lit.set(b.name, 1);
        if (!pres.has(b.name)) pres.set(b.name, 1);
        if (b.lane > 0 && !seen.has(b.lane)) { seen.add(b.lane); lanes.push(b.lane); }
      }
      // Which side a column goes to, and how far along it, is decided here
      // rather than by the lane numbers the server handed out: those encode
      // packing order, which has nothing to do with divergence. Sort every
      // column by how far it has moved from the trunk and deal them
      // alternately left and right, so both sides fill from the middle
      // outward in step and equal divergence means equal distance whichever
      // side you land on.
      //
      // Re-ordering columns is safe. The server packed branches into lanes so
      // that no two sharing one could ever overlap in time; which slot a lane
      // occupies does not change that.
      const dv = laneDivergences();
      lanes.sort((m, n) => (dv.get(m) ?? 0) - (dv.get(n) ?? 0) || m - n);
      laneOrder = { left: [], right: [] };
      lanes.forEach((lane, i) => (i % 2 ? laneOrder.right : laneOrder.left).push(lane));
      applyFilter();
      for (const lane of [...laneOrder.left, ...laneOrder.right]) {
        laneW.set(lane, laneWeightTarget(lane));
      }
      rebuildLanes();
      commitBySha = new Map(g.commits.map(c => [c.sha, c]));
      // Sorted once here rather than on every frame: the trunk must paint last
      // so branches join it from underneath.
      sortedEdges = g.edges.slice().sort(
        (p, q) => (p.b === main ? 1 : 0) - (q.b === main ? 1 : 0));
      orderedBranches = [...branchInfo.values()];
      buckets = new Map();
      for (const c of g.commits) {
        const k = Math.floor(c.y / CELL);
        let bucket = buckets.get(k);
        if (!bucket) buckets.set(k, bucket = []);
        bucket.push(c);
      }
      buildNeighbours();
      focusPin = null;   // the tips it was built from may have moved
      pathKey = null;    // the tips may have moved; recompute against the new graph
      computePath();
      dirty = true;
    }

    const colorOf = (name) => (branchInfo.get(name) || {}).color || [140, 134, 120];

    // ------------------------------------------------------- merge-base path
    /** Every commit reachable from `sha` by walking parents, within the window.
     *  Commits outside the loaded window simply stop the walk - the picture can
     *  only ever highlight history it actually has. */
    function ancestorsOf(sha) {
      const seen = new Set();
      const queue = [sha];
      while (queue.length) {
        const s = queue.pop();
        if (!s || seen.has(s) || !commitBySha.has(s)) continue;
        seen.add(s);
        for (const p of commitBySha.get(s).parents) queue.push(p);
      }
      return seen;
    }

    /** Work out what joins the current selection, and to what.
     *
     *  One branch picked: the answer is about it and the default branch. Two
     *  picked: it is about the pair, and the trunk is beside the point.
     *
     *  The meeting point is the newest commit both sides can reach - the merge
     *  base. Everything above it on either side is what has happened since they
     *  agreed, and that is exactly the work a merge has to reconcile.
     */
    function computePath() {
      // Hovering the branch list calls setSelection too. The walk below is
      // cheap but not free, and none of it depends on what is under the
      // cursor, so skip it unless the actual selection moved.
      const key = `${sel.a}|${sel.b}|${sel.focus}`;
      if (key === pathKey) return false;
      pathKey = key;
      path = null;
      focusNames = null;
      const one = sel.a || sel.focus;
      const other = sel.b || (one === mainName ? null : mainName);
      if (!one || !other || one === other) return true;

      const tipA = (branchInfo.get(one) || {}).tip;
      const tipB = (branchInfo.get(other) || {}).tip;
      if (!tipA || !tipB || !commitBySha.has(tipA) || !commitBySha.has(tipB)) return true;

      const A = ancestorsOf(tipA), B = ancestorsOf(tipB);
      let base = null, bestY = Infinity;
      for (const sha of A) {
        if (!B.has(sha)) continue;
        // y runs negative upward, so the smallest y is the newest commit. With
        // criss-crossed merges git can report several merge bases; the newest
        // is the one that makes the shortest honest story.
        const y = commitBySha.get(sha).y;
        if (y < bestY) { bestY = y; base = sha; }
      }
      if (!base) return true;

      const below = ancestorsOf(base);
      const nodes = new Set([base]);
      for (const set of [A, B]) {
        for (const sha of set) if (!below.has(sha)) nodes.add(sha);
      }

      // Kept as the edge objects themselves, not as keys to test later: the
      // highlight is redrawn every frame it is up, and rescanning a few
      // thousand edges each time to find the same handful is wasted work.
      const edges = [];
      const branches = new Set();
      for (const e of sortedEdges) {
        if (!e.p || !nodes.has(e.c) || !nodes.has(e.p)) continue;
        edges.push(e);
        if (e.b) branches.add(e.b);
      }
      for (const sha of nodes) {
        const c = commitBySha.get(sha);
        if (c && c.branch) branches.add(c.branch);
      }
      path = { nodes, edges, base, branches, ends: [one, other] };

      // Picking a pair is a statement about those two branches. Everything
      // not on the road between them steps back - the same channel the filter
      // uses, so this costs no extra work per frame.
      if (sel.a && sel.b) focusNames = new Set([...branches, sel.a, sel.b]);
      return true;
    }

    /** What the highlighted path will occupy once the layout has caught up. */
    function pathExtent() {
      if (!path) return null;
      const seen = [];
      for (const sha of path.nodes) {
        const c = commitBySha.get(sha);
        if (c) seen.push({ lane: c.lane, top: c.y, bot: c.y });
      }
      return extentOf(seen);
    }



    /** Walk each side outward from the trunk, giving every lane the width its
     *  weight asks for, and park the line in the middle of its own slab. */
    function layoutLanes(weightOf) {
      const pos = new Map([[0, 0]]);
      for (const side of [-1, 1]) {
        const lanes = side < 0 ? laneOrder.left : laneOrder.right;
        let acc = TRUNK_GUTTER - 0.5;
        for (const lane of lanes) {
          const w = weightOf(lane);
          pos.set(lane, side * (acc + w / 2));
          acc += w;
        }
      }
      return pos;
    }

    const rebuildLanes = () => { lanePos = layoutLanes(lane => laneW.get(lane) ?? 1); };

    /** How far the branches sharing a lane have diverged - the furthest of
     *  them, since a lane holds whichever branches did not overlap in time.
     *  Built in one pass: it is a sort key, and computing it inside the
     *  comparator walked every branch for every comparison. */
    function laneDivergences() {
      const dv = new Map();
      for (const b of branchInfo.values()) {
        if (b.lane > 0) dv.set(b.lane, Math.max(dv.get(b.lane) ?? 0, b.divergence || 0));
      }
      return dv;
    }

    /** The slab a lane occupies, in column widths.
     *
     *  Two things multiply into it. Divergence sets how much room the column
     *  takes, and since positions accumulate outward, a lane's distance from
     *  the trunk ends up being the divergence of everything between it and the
     *  trunk. The filter then scales that down for branches you did not ask
     *  for. Recomputed when either changes, not per frame.
     */
    function recomputeLaneTargets() {
      laneTarget = new Map();
      const faded = focusNames ? FOCUS_W : FADED_W;
      for (const b of branchInfo.values()) {
        if (b.lane <= 0) continue;
        const t = Math.min(1, (b.divergence || 0) / SPREAD_FULL);
        const room = SPREAD_NEAR + (SPREAD_FAR - SPREAD_NEAR) * t;
        const want = room * (faded + (1 - faded) * presTarget(b.name));
        laneTarget.set(b.lane, Math.max(laneTarget.get(b.lane) ?? 0, want));
      }
    }
    const laneWeightTarget = (lane) => laneTarget.get(lane) ?? 1;

    /** How much of the picture a branch is entitled to, 0 or 1.
     *
     *  The trunk always keeps all of it. A chosen pair overrules the filter -
     *  picking two branches is a stronger statement about what you want to see
     *  than anything typed in the box, and it would be perverse to fade out
     *  half of the comparison you just asked for. Otherwise the filter decides.
     */
    function presTarget(name) {
      const b = branchInfo.get(name);
      if (b && b.isMain) return 1;
      if (focusPin) return focusPin.names.has(name) ? 1 : 0;
      if (focusNames) return focusNames.has(name) ? 1 : 0;
      return (match.get(name) === false && !isChosen(name)) ? 0 : 1;
    }
    const presOf = (name) => pres.get(name) ?? 1;

    /** Recompute which branches the filter keeps. The trunk always stays: it
     *  is the thing everything else is measured against, so hiding it would
     *  leave the survivors with nothing to be read against. */
    function applyFilter() {
      match = new Map();
      for (const b of branchInfo.values()) {
        match.set(b.name, !filterRe || b.isMain ||
                  filterRe.test(b.name) || (!!b.label && filterRe.test(b.label)));
      }
      recomputeLaneTargets();
    }

    /** Narrow the picture to the branches matching `re` (null clears it).
     *  Returns how many non-trunk branches matched.
     *
     *  The camera reframes too, on the same glide the columns move on. The
     *  columns giving up their width is only half the point; the other half
     *  is spending the width that frees up on the branches you asked for.
     */
    function setFilter(re) {
      const before = filterRe && filterRe.source;
      filterRe = re || null;
      applyFilter();
      dirty = true;
      if (before !== (filterRe && filterRe.source)) {
        filterRe ? fitMatches(true) : fit(true);
      }
      let n = 0;
      for (const b of branchInfo.values()) if (!b.isMain && match.get(b.name)) n++;
      return n;
    }

    const matches = (name) => match.get(name) !== false;

    /** Which branches touch which, built once per load.
     *
     *  Every edge whose two ends belong to different branches is a place where
     *  one branch left another or came back into it - a fork or a merge. Those
     *  are exactly the ties worth calling a connection, and reading them off
     *  the edges costs one pass.
     *
     *  Walking ancestry instead, which is the obvious thing to try, gets the
     *  default branch badly wrong: nothing descends from its tip, so a trunk
     *  that half the repository forked out of comes back connected to almost
     *  nothing.
     */
    function buildNeighbours() {
      branchNeighbours = new Map();
      const link = (a, b) => {
        if (!a || !b || a === b) return;
        if (!branchNeighbours.has(a)) branchNeighbours.set(a, new Set());
        branchNeighbours.get(a).add(b);
      };
      for (const e of graph.edges) {
        if (!e.p) continue;
        const child = commitBySha.get(e.c), parent = commitBySha.get(e.p);
        if (!child || !parent) continue;
        link(child.branch, parent.branch);
        link(parent.branch, child.branch);
      }
    }

    /** A branch and everything it forked from, forked into, merged in, or was
     *  merged into. One hop: the things it is actually tied to, not the whole
     *  repository by transitive closure. */
    function neighboursOf(name) {
      return new Set([name, ...(branchNeighbours.get(name) || [])]);
    }

    /** Single one branch out: put its column in the middle, frame its history,
     *  and keep only the branches it shares history with in the foreground. */
    function focusOn(name) {
      if (!branchInfo.has(name)) return null;
      const b = branchInfo.get(name);
      focusPin = { name, names: neighboursOf(name) };
      recomputeLaneTargets();

      const pos = layoutLanes(laneWeightTarget);
      const origin = pos.get(b.lane) ?? 0;

      // The frame is taken from the branch itself, never from its neighbours.
      // Framing the whole neighbourhood sounds right and is not: the trunk, or
      // anything merged into it, drags the span out to the length of the whole
      // repository, the scale bottoms out at the legibility floor, and the
      // branch you double-clicked ends up thousands of pixels below the
      // viewport. The neighbours are context; the branch is the subject.
      let top = b.yTop, bot = b.yBot;
      // A fixed breathing space, not a proportional one. A share of the span
      // is a sane margin on a five-commit branch and half a screen of nothing
      // on the trunk.
      const margin = MIN_DY_FALLBACK * 2;
      top -= margin; bot += margin;

      // A long branch cannot be shown whole at a scale you can read - the
      // trunk of a busy repository is tens of thousands of pixels tall. Rather
      // than zoom out until it is a smear, or fit it and lose it off the
      // bottom, show its newest end: singling out a branch is a question about
      // where it has got to.
      const readable = (H - 160) / (MIN_GAP_PX / (graph.bounds.minDy || MIN_DY_FALLBACK));
      if (bot - top > readable) bot = top + readable;

      // Sideways, reach for the branches it is tied to - but not so far that
      // the columns are crushed to drag one outlier into shot. The branch is
      // centred either way, so what falls off the edge is only ever context.
      let reach = 0.75;
      for (const other of focusPin.names) {
        const n = branchInfo.get(other);
        if (n) reach = Math.max(reach, Math.abs((pos.get(n.lane) ?? 0) - origin));
      }
      reach = Math.min(reach, Math.max(1, (W / 2 - 128) / PIN_PITCH));

      frameOn({ top, bot, reach }, true, origin);
      dirty = true;
      return focusPin.names.size;
    }

    /** How present a connector between two columns is.
     *
     *  A connector belongs to both ends, not to one of them, so it survives
     *  only if the branches at both ends did. Judging it by the branch the
     *  edge is filed under let every curve out of the trunk through: those are
     *  filed under the trunk, which always matches, so a filter for one branch
     *  still left the fan of every other branch leaving main.
     */
    function edgeEnds(e) {
      const child = commitBySha.get(e.c);
      const parent = e.p ? commitBySha.get(e.p) : null;
      const a = child ? presOf(child.branch) : presOf(e.b);
      const b = parent ? presOf(parent.branch) : a;
      return Math.min(a, b);
    }

    /** How strongly an edge is drawn, 0 to 1. The drawing code and anything
     *  asking about it share this, so the two cannot drift apart. */
    function edgeFade(e) {
      const l = litOf(e.b);
      return e.lane0 !== e.lane1
        ? Math.max(l, litOf(mainName)) * edgeEnds(e)
        : l;
    }

    /** Widest column offset in use, in either direction. Measured against
     *  where the columns are *going*, not where the animation has got to:
     *  the camera and the columns then glide to the same picture together,
     *  instead of the camera having to wait its turn. */
    function laneSpread(pos) {
      pos = pos || lanePos;
      let lo = 0, hi = 0;
      for (const b of branchInfo.values()) {
        const o = pos.get(b.lane) ?? laneOffset(b.lane);
        lo = Math.min(lo, o); hi = Math.max(hi, o);
      }
      return { lo, hi, span: (hi - lo) + 1 };
    }

    function fit(animate = true) {
      const b = graph.bounds;
      if (!b || !graph.commits.length) return;
      const { lo, hi } = laneSpread(layoutLanes(laneWeightTarget));
      const padX = 118, padY = 62;

      // The trunk sits dead centre and both sides get equal room, so the
      // picture always reads as branches diverging from one spine. Half the
      // viewport has to hold whichever side reaches further; when it cannot,
      // the pitch bottoms out at COL_MIN and the far columns run off the edge
      // to be panned to, rather than everything being crushed together.
      const reach = Math.max(0.75, Math.abs(lo), Math.abs(hi));
      const cw = Math.max(COL_MIN, Math.min(COL_MAX, (W / 2 - padX) / reach));
      // Two commits a minute apart sit minDy world units apart. Scaling below
      // the point where that gap is MIN_GAP_PX draws one dot on top of the
      // next and turns the trunk into a caterpillar, so that is the floor
      // even when it means the history runs off the bottom of the screen.
      const floor = MIN_GAP_PX / (b.minDy || MIN_DY_FALLBACK);
      const whole = (H - padY * 2) / Math.max(1, b.maxY - b.minY);
      const s = Math.max(floor, Math.min(whole, 2.4));
      // Where the view opens. Three cases, in order of what is worth seeing.
      const room = H - padY * 2;
      const spine = branchInfo.get(mainName);
      const mainTop = spine ? spine.yTop : b.minY;
      let ty;
      if ((b.maxY - b.minY) * s <= room) {
        ty = H / 2 - ((b.minY + b.maxY) / 2) * s;   // it all fits: centre it
      } else if ((mainTop - b.minY) * s <= room * 0.62) {
        // Newest commits at the top, with main's tip comfortably below them.
        ty = padY - b.minY * s;
      } else {
        // Main has not been touched in a while and some branch has run a long
        // way ahead of it. Leading with that branch would open the page on a
        // trunk that is nowhere in sight, and the trunk is what the whole
        // picture is measured against. So main's tip anchors the view - but a
        // third of the way down, not against the top edge, so the newer work
        // above it is in shot too rather than entirely out of frame.
        ty = H * 0.34 - mainTop * s;
      }
      const target = { cw, s, tx: W / 2, ty };
      if (!animate) { Object.assign(cam, target); dirty = true; return; }
      glide(target);
    }

    function focusBranch(name) {
      const b = branchInfo.get(name);
      if (!b) return;
      glide({
        s: Math.max(cam.s, 0.22), cw: cam.cw,
        tx: W / 2 - offsetOf(b.lane) * cam.cw,
        ty: H * 0.38 - b.yTop * Math.max(cam.s, 0.22),
      });
    }

    /** What the branches surviving the filter occupy, on both axes. Null if
     *  the filter has kept nothing but the trunk. */
    function matchExtent() {
      const kept = [];
      for (const b of branchInfo.values()) {
        if (b.isMain || match.get(b.name) === false) continue;
        kept.push({ lane: b.lane, top: b.yTop, bot: b.yBot });
      }
      return extentOf(kept);
    }

    /** The box a set of things occupies: their span on the time axis, and how
     *  far from the trunk the furthest of them sits.
     *
     *  Measured against the lane widths the columns are *heading for*, so it
     *  can only be asked once the filter or the focus has been folded into
     *  them. Asked earlier it describes the layout that is about to be
     *  replaced, and the camera frames a picture that will not exist.
     */
    function extentOf(items, origin = 0) {
      const pos = layoutLanes(laneWeightTarget);
      let top = Infinity, bot = -Infinity, reach = 0.75;
      for (const it of items) {
        top = Math.min(top, it.top);
        bot = Math.max(bot, it.bot);
        reach = Math.max(reach, Math.abs((pos.get(it.lane) ?? 0) - origin));
      }
      return top === Infinity ? null : { top, bot, reach };
    }

    /** Move onto what the filter kept, rather than onto the whole graph.
     *
     *  Shrinking the columns of everything else is only worth doing if the
     *  camera then spends the room on the survivors: zoomed to their span and
     *  centred on their stretch of history, so a filter for one branch puts
     *  that branch on the screen at a size you can actually read.
     */
    function fitMatches(animate = true) {
      const ext = matchExtent();
      return ext ? frameOn(ext, animate) : fit(animate);
    }

    /** Point the camera at one stretch of the graph and zoom to hold it.
     *
     *  COL_MIN is the floor for fitting the whole repository, where refusing to
     *  squeeze is right: thirty branches crushed together help nobody, and
     *  panning is the better answer. Framing a chosen few is the opposite case
     *  - they were asked for by name, so getting them inside the viewport wins
     *  over holding a comfortable pitch. The lower floor is still well clear of
     *  the width at which name plates are dropped.
     */
    function frameOn(ext, animate = true, origin = 0) {
      const b = graph.bounds;
      if (!b || !graph.commits.length) return;
      const padX = 128, padY = 80;
      const floorPitch = Math.round(COL_MIN * 0.5);
      const cw = Math.max(floorPitch, Math.min(COL_MAX, (W / 2 - padX) / ext.reach));
      const floor = MIN_GAP_PX / (b.minDy || MIN_DY_FALLBACK);
      const room = H - padY * 2;
      const span = Math.max(1, ext.bot - ext.top);
      const s = Math.max(floor, Math.min(room / span, 2.4));
      // Centre it if it fits, otherwise lead with its newest end.
      const ty = span * s <= room
        ? H / 2 - ((ext.top + ext.bot) / 2) * s
        : padY - ext.top * s;
      const target = { cw, s, tx: W / 2 - origin * cw, ty };
      if (!animate) { Object.assign(cam, target); dirty = true; return; }
      glide(target, REFRAME_MS);
    }

    let gliding = null;
    function glide(target, dur = GLIDE_MS) {
      const from = { ...cam };
      const t0 = performance.now();
      gliding = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        // Eased at both ends. A long move that starts as abruptly as a short
        // one reads as a jump with a slow tail; this one sets off and settles.
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        for (const key of ["s", "cw", "tx", "ty"]) {
          cam[key] = from[key] + ((target[key] ?? from[key]) - from[key]) * e;
        }
        dirty = true;
        if (k >= 1) gliding = null;
      };
      dirty = true;
    }

    // -------------------------------------------------------------- picking
    /** Nearest commit within `slop` pixels, or null. */
    function nodeAt(px, py, slop) {
      const wy = toWorldY(py);
      const k = Math.floor(wy / CELL);
      const reach = Math.min(64, Math.ceil((slop + NODE_R) / cam.s / CELL) + 1);
      let best = null, bestD = Infinity;
      for (let i = -reach; i <= reach; i++) {
        const bucket = buckets.get(k + i);
        if (!bucket) continue;
        for (const c of bucket) {
          const d = Math.hypot(sx(c.lane) - px, sy(c.y) - py);
          if (d < slop + nodeRadius(c) && d < bestD) { bestD = d; best = c; }
        }
      }
      return best;
    }

    function plateAt(px, py) {
      // Topmost first: plates are drawn in order, the last one wins.
      for (let i = labelRects.length - 1; i >= 0; i--) {
        const r = labelRects[i];
        if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) return r.name;
      }
      return null;
    }

    /** Is this node hidden underneath a name plate? */
    function covered(c) {
      const x = sx(c.lane), y = sy(c.y);
      return labelRects.some(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    }

    function pick(px, py) {
      // Well inside a node that you can actually see beats everything else.
      // A node buried under a plate must not steal the plate's click: you
      // cannot see it, so clicking there can only have meant the plate.
      const exact = nodeAt(px, py, -1);
      if (exact && !covered(exact)) {
        return { type: "commit", commit: exact, branch: exact.branch };
      }

      // Otherwise a plate you can see is a plate you can click.
      const plate = plateAt(px, py);
      if (plate) return { type: "branch", branch: plate };

      // Away from plates, give nodes a generous target.
      const near = nodeAt(px, py, PICK_SLOP);
      if (near) return { type: "commit", commit: near, branch: near.branch };

      let bb = null, bd = Infinity;
      for (const b of branchInfo.values()) {
        const top = sy(b.yTop), bot = sy(b.yBot);
        if (py > bot + 26 || py < top - 46) continue;
        const d = Math.abs(sx(b.lane) - px);
        if (d < Math.min(22, cam.cw / 2) && d < bd) { bd = d; bb = b; }
      }
      return bb ? { type: "branch", branch: bb.name } : null;
    }

    // ------------------------------------------------------------ animation
    function stepEasing(dt) {
      let moving = false;
      const k = Math.min(1, dt / EASE_MS);
      for (const name of branchInfo.keys()) {
        const target = targetLit(name);
        const cur = lit.get(name) ?? 1;
        const next = cur + (target - cur) * k;
        if (Math.abs(next - target) > 0.004) moving = true;
        lit.set(name, Math.abs(next - target) <= 0.004 ? target : next);
      }

      // Filter presence, and the column widths that follow from it. Widths
      // are eased rather than snapped, so branches slide aside and the
      // matches open out instead of the whole graph teleporting.
      const kf = Math.min(1, dt / FILTER_MS);
      for (const name of branchInfo.keys()) {
        const target = presTarget(name);
        const cur = presOf(name);
        const next = cur + (target - cur) * kf;
        if (Math.abs(next - target) > 0.004) moving = true;
        pres.set(name, Math.abs(next - target) <= 0.004 ? target : next);
      }
      let shifted = false;
      for (const lane of lanePos.keys()) {
        if (lane <= 0) continue;
        const target = laneWeightTarget(lane);
        const cur = laneW.get(lane) ?? 1;
        if (Math.abs(cur - target) <= 0.002) { laneW.set(lane, target); continue; }
        laneW.set(lane, cur + (target - cur) * kf);
        shifted = moving = true;
      }
      if (shifted) rebuildLanes();
      return moving;
    }

    function targetLit(name) {
      const b = branchInfo.get(name);
      if (b && b.isMain) return 1;
      if (spawn && name === spawn.name) return 1;
      if (focusPin) return focusPin.names.has(name) ? 1 : DIM * 0.5;
      if (!sel.focus && !sel.a && !sel.b && !sel.hoverBranch) return 1;
      // With a pair up, everything else is context, not content.
      if (sel.a && sel.b && !(path && path.branches.has(name))) {
        return name === sel.a || name === sel.b || name === sel.hoverBranch ? 1 : DIM * 0.5;
      }
      // A branch the highlighted path runs through is part of the answer, even
      // if you never clicked it: dimming it would break the line mid-story.
      if (path && path.branches.has(name)) return 1;
      return (name === sel.focus || name === sel.a || name === sel.b ||
              name === sel.hoverBranch) ? 1 : DIM;
    }
    // Two independent fades multiply: selection dimming, and the filter.
    const litOf = (name) =>
      (lit.get(name) ?? 1) * (FADED_LIT + (1 - FADED_LIT) * presOf(name));

    /** 0..1 while a newly created branch is growing in, else null. */
    function spawnP(now) {
      if (!spawn) return null;
      const p = (now - spawn.t0) / SPAWN_MS;
      if (p >= 1) { spawn = null; return null; }
      return Math.max(0, p);
    }

    function markSpawn(name) {
      if (!branchInfo.has(name)) return;
      spawn = { name, t0: performance.now() };
      dirty = true;
    }

    // Reveal height for the growing branch: it climbs from its root upward.
    function revealY(b, p) {
      const e = 1 - Math.pow(1 - p, 2.2);
      return b.yBot + (b.yTop - b.yBot) * e;
    }

    // -------------------------------------------------------------- drawing
    function draw(now) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      if (!graph.commits.length) return;
      const p = spawnP(now);
      const sb = p !== null ? branchInfo.get(spawn.name) : null;
      const cut = sb ? revealY(sb, p) : null;

      drawTimeRuler();
      drawTrunk();
      drawColumns(sb, cut);
      drawCorridors();
      drawEdges(sb, cut);
      drawPath(now);
      drawLineage(now);
      drawNodes(now, sb, cut);
      if (sb) drawSpawnFlare(sb, p, cut);
      drawLabels(sb, p);
    }

    function drawTimeRuler() {
      const b = graph.bounds;
      if (!b || !b.maxTs) return;
      const spanY = (b.maxY - b.minY) || 1;
      const spanT = (b.maxTs - b.minTs) || 1;
      const step = 132 / cam.s;
      const yHi = toWorldY(0), yLo = toWorldY(H);
      const first = Math.ceil(yHi / step) * step;
      ctx.font = "9.5px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let wy = first; wy <= yLo; wy += step) {
        const py = Math.round(sy(wy)) + 0.5;
        if (py < 10 || py > H - 4) continue;
        const ts = b.maxTs - ((wy - b.minY) / spanY) * spanT;
        ctx.strokeStyle = "rgba(226,219,204,.045)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
        ctx.fillStyle = "rgba(196,188,172,.62)";
        ctx.fillText(fmtDate(ts), 10, py - 8);
      }
    }

    /** The trunk gets a band the full height of the viewport, not just the
     *  length of its own commits. It is the axis every other line is read
     *  against, so it has to be findable from anywhere in the picture - after
     *  you have panned three screens out to a stale branch, most of all. */
    function drawTrunk() {
      const b = branchInfo.get(mainName);
      if (!b) return;
      const x = sx(b.lane);
      const half = Math.max(18, Math.min(52, cam.cw * TRUNK_GUTTER * 0.42));
      if (x < -half || x > W + half) return;
      const g = ctx.createLinearGradient(x - half, 0, x + half, 0);
      g.addColorStop(0, rgba(MAIN_RGB, 0));
      g.addColorStop(.5, rgba(MAIN_RGB, .05));
      g.addColorStop(1, rgba(MAIN_RGB, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - half, 0, half * 2, H);
      const px = Math.round(x) + 0.5;
      ctx.strokeStyle = rgba(MAIN_RGB, .1);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }

    function drawColumns(sb, cut) {
      for (const b of branchInfo.values()) {
        const x = Math.round(sx(b.lane)) + 0.5;
        if (x < -40 || x > W + 40) continue;
        let top = b.yTop;
        if (sb && b.name === sb.name) top = Math.max(cut, b.yTop);
        const l = litOf(b.name);
        ctx.strokeStyle = b.isMain ? rgba(MAIN_RGB, .09) : rgba(b.color, .055 * l);
        ctx.lineWidth = b.isMain ? 18 : 10;
        ctx.beginPath(); ctx.moveTo(x, sy(top)); ctx.lineTo(x, sy(b.yBot)); ctx.stroke();
      }
    }

    function drawCorridors() {
      const spine = branchInfo.get(mainName);
      if (!spine) return;
      for (const name of new Set([sel.a, sel.b, sel.focus])) {
        const b = name && branchInfo.get(name);
        if (!b || b.isMain) continue;
        const x0 = sx(spine.lane), x1 = sx(b.lane);
        const y0 = sy(b.yTop), y1 = sy(b.yBot);
        if (Math.max(y0, y1) < 0 || Math.min(y0, y1) > H) continue;
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, rgba(b.color, 0));
        g.addColorStop(1, rgba(b.color, .12 * litOf(name)));
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1),
                     Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
    }

    /** Thin ties from a merge-test branch back to the branches it was made of.
     *
     *  Such a branch is often a single commit sitting on its base, so nothing
     *  in the commit graph shows where it came from. Without this it reads as
     *  having appeared out of nowhere.
     */
    function drawLineage(now) {
      const shown = new Set([sel.focus, sel.a, sel.b, sel.hoverBranch].filter(Boolean));
      if (!shown.size) return;
      const dash = (now / 45) % 14;      // slow crawl along the tie
      for (const name of shown) {
        const b = branchInfo.get(name);
        if (!b || !b.parents || !b.parents.length) continue;
        const x1 = sx(b.lane), y1 = sy(b.yTop);
        for (const pn of b.parents) {
          const p = branchInfo.get(pn);
          if (!p) continue;
          const x0 = sx(p.lane), y0 = sy(p.yTop);
          if (Math.max(y0, y1) < -60 || Math.min(y0, y1) > H + 60) continue;

          const lift = Math.max(38, Math.abs(x1 - x0) * 0.4);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.bezierCurveTo(x0, y0 - lift, x1, y1 - lift, x1, y1);
          ctx.setLineDash([5, 9]);
          ctx.lineDashOffset = -dash;
          ctx.strokeStyle = rgba(b.color, .30);
          ctx.lineWidth = 3.5;
          ctx.stroke();
          ctx.strokeStyle = rgba(b.color, .85);
          ctx.lineWidth = 1.3;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;

          // A dot at the source end says which way the lineage runs.
          ctx.beginPath(); ctx.arc(x0, y0, 3.4, 0, 6.2832);
          ctx.fillStyle = rgba(b.color, .9); ctx.fill();
        }
      }
    }

    /** Lay down one edge's geometry. Both the ordinary pass and the path
     *  highlight stroke this, so the bright line always lands exactly on the
     *  line underneath it. */
    function traceEdge(e, x0, y0, x1, y1) {
      ctx.beginPath();
      if (e.lane0 !== e.lane1) {
        // Control points pulled along the time axis: a long lazy S rather
        // than a tight elbow.
        const dy = (y1 - y0) * 0.5;
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(x0, y0 + dy, x1, y1 - dy, x1, y1);
      } else {
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
    }

    function drawEdges(sb, cut) {
      const lod = cam.s < 0.10;
      for (const e of sortedEdges) {
        if (sb && e.b === sb.name && e.y1 < cut) continue;   // not grown yet
        const y0 = sy(e.y0), y1 = sy(e.y1);
        if (Math.max(y0, y1) < -90 || Math.min(y0, y1) > H + 90) continue;
        const x0 = sx(e.lane0), x1 = sx(e.lane1);
        if (Math.max(x0, x1) < -90 || Math.min(x0, x1) > W + 90) continue;

        const isMain = e.b === mainName;
        const c = colorOf(e.b);
        const l = litOf(e.b);

        traceEdge(e, x0, y0, x1, y1);
        // A filtered-out branch goes thin as well as faint: at a glance the
        // matches are the only lines with any weight to them.
        const base = isMain ? 2.4 : 1.5 * (0.42 + 0.58 * presOf(e.b));
        // A line crossing between columns is a branch leaving the trunk or
        // rejoining it, and it carries that branch's colour - which is why
        // lines leaving a white trunk are not white. Blending the colour
        // along the curve says so: it starts as trunk and becomes the branch.
        const cross = e.lane0 !== e.lane1;
        // A branch the filter excluded keeps its own line, but its connectors
        // to the rest of the graph go entirely: those curves sweep across
        // everything else, and leaving them behind is exactly the clutter the
        // filter was asked to clear. A connector needs both of its ends.
        const fade = edgeFade(e);
        if (fade <= 0.01) continue;

        // One paint for all three passes, varying only globalAlpha. Building a
        // gradient is not free and the glow used to build three of them per
        // curve per frame.
        let paint;
        if (cross) {
          const trunk = colorOf(mainName);
          paint = ctx.createLinearGradient(x0, y0, x1, y1);
          paint.addColorStop(0, css(e.merge ? c : trunk));
          paint.addColorStop(1, css(e.merge ? trunk : c));
        } else {
          paint = css(c);
        }
        ctx.strokeStyle = paint;
        if (!lod && fade > 0.5) {
          ctx.globalAlpha = .05 * fade; ctx.lineWidth = base * 3.0; ctx.stroke();
          ctx.globalAlpha = .09 * fade; ctx.lineWidth = base * 1.7; ctx.stroke();
        }
        // A merge edge is dashed: it is the one line on the canvas that runs
        // against the grain, carrying a whole branch back into another rather
        // than just joining a commit to its parent. A fork keeps a solid line,
        // because a branch starting is not the same event as one ending.
        if (e.merge) ctx.setLineDash([7, 5]);
        ctx.globalAlpha = e.kind === "stub" ? fade * .3 : e.merge ? fade * .85 : fade;
        ctx.lineWidth = base;
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (e.merge) ctx.setLineDash([]);
      }
    }

    /** Re-stroke the commits joining the selection, over the top of the
     *  ordinary graph, so the route reads as one continuous thing rather than
     *  as whichever branch colours happen to lie along it. */
    function drawPath(now) {
      if (!path) return;
      const pulse = 0.82 + 0.18 * Math.sin(now / 420);
      for (const e of path.edges) {
        const y0 = sy(e.y0), y1 = sy(e.y1);
        if (Math.max(y0, y1) < -90 || Math.min(y0, y1) > H + 90) continue;
        const x0 = sx(e.lane0), x1 = sx(e.lane1);
        if (Math.max(x0, x1) < -90 || Math.min(x0, x1) > W + 90) continue;
        traceEdge(e, x0, y0, x1, y1);
        ctx.strokeStyle = rgba(PATH_RGB, .12 * pulse); ctx.lineWidth = 11; ctx.stroke();
        ctx.strokeStyle = rgba(PATH_RGB, .30 * pulse); ctx.lineWidth = 5.5; ctx.stroke();
        ctx.strokeStyle = rgba(PATH_RGB, .95);         ctx.lineWidth = 2.0; ctx.stroke();
      }
      drawBaseMarker();
    }

    /** The commit where the two sides last agreed. Everything the highlight
     *  covers happened after this; naming it is the whole point of drawing
     *  the path at all. */
    function drawBaseMarker() {
      const c = commitBySha.get(path.base);
      if (!c) return;
      const x = sx(c.lane), y = sy(c.y);
      if (x < -140 || x > W + 140 || y < -60 || y > H + 60) return;
      ctx.beginPath(); ctx.arc(x, y, 13, 0, 6.2832);
      ctx.strokeStyle = rgba(PATH_RGB, .9); ctx.lineWidth = 1.6; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 19, 0, 6.2832);
      ctx.strokeStyle = rgba(PATH_RGB, .3); ctx.lineWidth = 1; ctx.stroke();
      if (cam.cw < 80) return;
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = "COMMON ANCESTOR";
      const w = measure(label, false) + 12;
      ctx.fillStyle = "rgba(10,10,9,.92)";
      roundRect(x - w / 2, y + 22, w, 15, 3); ctx.fill();
      ctx.strokeStyle = rgba(PATH_RGB, .45); ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = rgba(PATH_RGB, .95);
      ctx.fillText(label, x, y + 30);
    }

    function drawNodes(now, sb, cut) {
      const detail = cam.s > 0.12;
      for (const c of graph.commits) {
        if (sb && c.branch === sb.name && c.y < cut) continue;
        const x = sx(c.lane), y = sy(c.y);
        if (x < -26 || x > W + 26 || y < -26 || y > H + 26) continue;

        const isMain = c.branch === mainName;
        const col = colorOf(c.branch);
        const l = litOf(c.branch);
        const hov = sel.hover === c.sha;
        // Node size carries per-commit impact, so the biggest changes read at
        // a glance without having to hover anything.
        const r = nodeRadius(c);

        if (hov) {
          const pulse = 1 + 0.16 * Math.sin(now / 260);
          ctx.beginPath(); ctx.arc(x, y, r * 3.4 * pulse, 0, 6.2832);
          ctx.fillStyle = rgba(col, .10); ctx.fill();
          ctx.beginPath(); ctx.arc(x, y, r * 2.2 * pulse, 0, 6.2832);
          ctx.strokeStyle = rgba(col, .55); ctx.lineWidth = 1; ctx.stroke();
        } else if (detail && l > .8) {
          ctx.beginPath(); ctx.arc(x, y, r * 2.3, 0, 6.2832);
          ctx.fillStyle = rgba(col, .07); ctx.fill();
        }

        ctx.beginPath();
        if (c.merge) {
          const d = r * 1.42;
          ctx.moveTo(x, y - d); ctx.lineTo(x + d, y);
          ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
        } else {
          ctx.arc(x, y, r, 0, 6.2832);
        }
        ctx.fillStyle = BG; ctx.fill();
        ctx.strokeStyle = rgba(col, l);
        ctx.lineWidth = hov ? 2.8 : isMain ? 2.3 : 1.8;
        ctx.stroke();
        if (l > .8 || hov) {
          ctx.fillStyle = rgba(col, hov ? .95 : isMain ? .5 : .34);
          ctx.fill();
        }

        // A commit a model had a hand in, when you have asked to see them.
        // Drawn over the node rather than instead of it, so the branch colour
        // and the size-by-impact both survive.
        if (showAi && c.ai) {
          ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 6.2832);
          ctx.fillStyle = rgba(AI_RGB, .13 * l); ctx.fill();
          ctx.beginPath(); ctx.arc(x, y, r + 2.2, 0, 6.2832);
          ctx.strokeStyle = rgba(AI_RGB, .95 * l); ctx.lineWidth = 1.6; ctx.stroke();
        }

        if (detail && c.refs && c.refs.includes("HEAD")) {
          ctx.beginPath(); ctx.arc(x, y, r * 2.0, 0, 6.2832);
          ctx.strokeStyle = rgba(MAIN_RGB, .8); ctx.lineWidth = 1.1; ctx.stroke();
        }
      }
    }

    /** A bright head travelling up the new branch while it grows in. */
    function drawSpawnFlare(b, p, cut) {
      const x = sx(b.lane), y = sy(cut);
      const fade = 1 - Math.pow(p, 2);
      const col = b.color;
      ctx.beginPath(); ctx.arc(x, y, 26 * fade + 6, 0, 6.2832);
      ctx.fillStyle = rgba(col, .16 * fade); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 11 * fade + 3, 0, 6.2832);
      ctx.fillStyle = rgba(col, .8 * fade); ctx.fill();
      // Expanding ring at the tip once it lands.
      if (p > 0.72) {
        const q = (p - 0.72) / 0.28;
        ctx.beginPath(); ctx.arc(sx(b.lane), sy(b.yTop), 10 + 46 * q, 0, 6.2832);
        ctx.strokeStyle = rgba(col, 0.55 * (1 - q)); ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    function drawLabels(sb, p) {
      labelRects = [];
      // Zoomed out past the point where plates fit, only the branch under the
      // cursor and the ones you have picked keep theirs. Dropping every label
      // meant that at the zoom where you most need to know what you are
      // looking at, nothing on the canvas would tell you.
      const sparse = cam.cw < 46;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      // First pass: work out where each plate wants to sit and how big it is.
      const plates = [];
      // Only plates whose branch tip is actually on screen are considered. A
      // plate is part of the picture at a fixed place in it, so which ones are
      // in play has to depend on nothing but where you have scrolled to -
      // otherwise the arrangement drifts as you travel and does not come back.
      const plateTop = -140, plateBot = H + 140;
      for (const b of orderedBranches) {
        // A faded branch keeps its line but loses its name plate: the plates
        // are what actually make a big repository unreadable, and the point
        // of filtering is to get the other forty out of the way.
        if (!b.isMain && presOf(b.name) < 0.35 && !isChosen(b.name)) continue;
        if (sparse && !isChosen(b.name) && b.name !== sel.hoverBranch &&
            !(sel.hover && (commitBySha.get(sel.hover) || {}).branch === b.name)) continue;
        const x = sx(b.lane);
        if (x < -180 || x > W + 180) continue;
        const growing = sb && b.name === sb.name;
        const anchorY = sy(growing ? revealY(b, p) : b.yTop);
        if (anchorY < plateTop || anchorY > plateBot) continue;
        const chosen = isChosen(b.name);
        // Branches this tool created carry two names joined together, so they
        // get a hard character cap on top of the pixel budget.
        const wl = !!b.isWorldline;
        // A plate is not allowed to be wider than the column it belongs to.
        // That is what stops neighbouring plates from colliding at all, which
        // beats shuffling them out of each other's way after the fact: the
        // vertical sweep below now almost never has to move anything. Zoom in
        // for the rest of a long name; the rail and the tooltip have it in
        // full either way.
        const room = Math.max(84, cam.cw - 16);
        let raw = b.label || b.name;
        if (wl && raw.length > WL_MAX_CHARS) raw = clampEnds(raw, WL_MAX_CHARS);
        ctx.font = (b.isMain || chosen ? "600 " : "") + "12px ui-monospace, monospace";
        const label = fitText(raw, room, b.isMain || chosen);
        const w = measure(label, b.isMain || chosen) + 18;
        plates.push({ b, x, anchorY, chosen, label, w, h: 34, y: anchorY - 26, wl });
      }

      // Second pass: push plates apart so none is buried under another. A
      // buried plate is not just ugly - it cannot be clicked.
      //
      // Placement tests the *same* rectangle that hit-testing will later use,
      // including the A/B badge that hangs off the left edge - testing a
      // different box is how plates end up overlapping despite the sweep.
      // Sweeping in order of desired position and only ever pushing down
      // always terminates; nudging both ways can ping-pong forever.
      const GAP = 5;
      const rectOf = (x, y, w) => ({
        x0: x - w / 2 - 10, x1: x + w / 2 + 4,
        y0: y - 13, y1: y + 22,
      });
      const hits = (a, b) => a.x0 < b.x1 + GAP && b.x0 < a.x1 + GAP &&
                             a.y0 < b.y1 + GAP && b.y0 < a.y1 + GAP;

      // The trunk's plate is placed before anything else, so it never gets
      // shoved down the screen by a branch that happened to sort first.
      const order = [...plates].sort((m, n) =>
        (n.b.isMain ? 1 : 0) - (m.b.isMain ? 1 : 0) || m.y - n.y);
      const placed = [];
      for (const pl of order) {
        let y = pl.y;
        let r = rectOf(pl.x, y, pl.w);
        for (let guard = 0; guard < plates.length + 2; guard++) {
          const clash = labelRects.find(q => hits(q, r));
          if (!clash) break;
          y += (clash.y1 + GAP) - r.y0;       // drop clear of the blocker
          r = rectOf(pl.x, y, pl.w);
        }
        pl.y = y;
        placed.push(pl);
        labelRects.push({ name: pl.b.name, ...r });
      }
      // Restore the draw order: selected plates paint over the rest.
      placed.sort((m, n) => (m.chosen ? 1 : 0) - (n.chosen ? 1 : 0));

      // Third pass: draw.
      for (const pl of placed) {
        const { b, x, y, w, chosen, label, wl } = pl;
        const l = litOf(b.name);
        const col = b.color;
        const bh = 22;

        // If the plate had to move, tie it back to its own column.
        if (Math.abs(y - (pl.anchorY - 26)) > 8) {
          ctx.strokeStyle = rgba(col, .3 * Math.max(.5, l));
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(x, y + bh / 2); ctx.lineTo(x, pl.anchorY); ctx.stroke();
          ctx.setLineDash([]);
        }

        if (chosen) {
          ctx.fillStyle = rgba(col, .16);
          roundRect(x - w / 2 - 3, y - bh / 2 - 3, w + 6, bh + 6, 5);
          ctx.fill();
        }
        ctx.fillStyle = chosen ? "rgba(16,15,13,.97)" : "rgba(10,10,9,.92)";
        roundRect(x - w / 2, y - bh / 2, w, bh, 4);
        ctx.fill();
        ctx.strokeStyle = rgba(col, chosen ? 1 : b.isMain ? .55 : .32 * l);
        ctx.lineWidth = chosen ? 1.6 : 1;
        ctx.stroke();

        ctx.font = (b.isMain || chosen ? "600 " : "") + "12px ui-monospace, monospace";
        ctx.fillStyle = chosen ? css(col) : rgba(col, Math.max(.6, l));
        ctx.fillText(label, x, y);

        ctx.font = (chosen ? "600 " : "") + "10px ui-monospace, monospace";
        ctx.fillStyle = rgba(col, chosen ? .95 : Math.max(.45, l * .8));
        ctx.fillText(b.display, x, y + 16);

        const tag = sel.a === b.name ? "A" : sel.b === b.name ? "B" : null;
        if (tag) {
          ctx.beginPath(); ctx.arc(x - w / 2 - 9, y, 8, 0, 6.2832);
          ctx.fillStyle = css(col); ctx.fill();
          ctx.fillStyle = "#0a0a09";
          ctx.font = "700 10px ui-monospace, monospace";
          ctx.fillText(tag, x - w / 2 - 9, y + .5);
        }
        if (b.isHead) {
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillStyle = rgba(MAIN_RGB, .85);
          ctx.fillText("HEAD", x, y - 17);
        } else if (wl) {
          ctx.font = "8.5px ui-monospace, monospace";
          ctx.fillStyle = rgba(col, .8);
          ctx.fillText("MERGE TEST", x, y - 17);
        }
      }
    }

    const isChosen = (name) =>
      name === sel.a || name === sel.b || name === sel.focus;

    const WL_MAX_CHARS = 26;

    /** Trim from the middle, keeping both ends readable. */
    function clampEnds(text, max) {
      if (text.length <= max) return text;
      const head = Math.ceil((max - 1) / 2), tail = max - 1 - head;
      return text.slice(0, head) + "…" + text.slice(-tail);
    }

    /** Middle-ellipsis so a long branch name never runs into its neighbour. */
    function fitText(text, maxPx, bold) {
      if (measure(text, bold) <= maxPx) return text;
      let lo = 1, hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const head = Math.ceil(mid / 2), tail = mid - head;
        const candidate = text.slice(0, head) + "…" + (tail ? text.slice(-tail) : "");
        if (measure(candidate, bold) <= maxPx) lo = mid; else hi = mid - 1;
      }
      const head = Math.ceil(lo / 2), tail = lo - head;
      return text.slice(0, head) + "…" + (tail ? text.slice(-tail) : "");
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    const measureCache = new Map();
    function measure(text, bold) {
      // The font is part of the key: the same text is measured at more than
      // one size, and a width cached at 12px is wrong at 9px.
      const key = ctx.font + (bold ? "|b|" : "|n|") + text;
      let w = measureCache.get(key);
      if (w === undefined) { w = ctx.measureText(text).width; measureCache.set(key, w); }
      return w;
    }

    function fmtDate(ts) {
      const d = new Date(ts * 1000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    // ----------------------------------------------------------- input loop
    // Read once per resize, not on every pointer event: getBoundingClientRect
    // forces layout and pointermove outruns the paint loop.
    let viewRect = null;
    const rectOf = () => viewRect || (viewRect = canvas.getBoundingClientRect());
    let drag = null;
    canvas.addEventListener("pointerdown", (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      drag = { x: ev.clientX, y: ev.clientY, tx: cam.tx, ty: cam.ty, moved: false };
      canvas.classList.add("drag");
    });
    canvas.addEventListener("pointermove", (ev) => {
      const rect = rectOf();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        cam.tx = drag.tx + dx; cam.ty = drag.ty + dy;
        dirty = true;
        return;
      }
      const hit = pick(px, py);
      const hoverSha = hit && hit.type === "commit" ? hit.commit.sha : null;
      const hoverBr = hit ? hit.branch : null;
      if (hoverSha !== sel.hover || hoverBr !== sel.hoverBranch) {
        sel.hover = hoverSha; sel.hoverBranch = hoverBr; dirty = true;
        hooks.onHover && hooks.onHover(hit, { x: px, y: py });
      }
    });
    const endDrag = (ev) => {
      if (!drag) return;
      const wasClick = !drag.moved;
      drag = null;
      canvas.classList.remove("drag");
      if (wasClick && ev) {
        const rect = rectOf();
        const hit = pick(ev.clientX - rect.left, ev.clientY - rect.top);
        hooks.onPick && hooks.onPick(hit, ev);
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    // Double-click singles a branch out. The two ordinary clicks underneath
    // have already run their course by now, so the handler states the whole
    // selection rather than nudging whatever they left behind.
    canvas.addEventListener("dblclick", (ev) => {
      const rect = rectOf();
      const hit = pick(ev.clientX - rect.left, ev.clientY - rect.top);
      if (!hit) return;
      ev.preventDefault();
      hooks.onPin && hooks.onPin(hit.branch);
    });
    canvas.addEventListener("pointercancel", () => endDrag(null));
    canvas.addEventListener("pointerleave", () => {
      if (sel.hover || sel.hoverBranch) {
        sel.hover = sel.hoverBranch = null; dirty = true;
        hooks.onHover && hooks.onHover(null);
      }
    });

    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      // Holding shift scrolls the timeline instead of zooming it. Drawing
      // commits far enough apart to read makes the canvas taller than the
      // screen by design, so travelling along it has to be cheaper than
      // dragging it a screen at a time.
      if (ev.shiftKey) {
        // A mouse reports shift+wheel as deltaX and a trackpad as deltaY.
        // Both mean the same thing here - travel through time - and neither
        // should slide the picture sideways off its centre.
        cam.ty -= ev.deltaY || ev.deltaX;
        gliding = null;
        dirty = true;
        return;
      }
      const wy = toWorldY(py), lf = toLaneF(px);
      const f = Math.exp(-ev.deltaY * 0.0016);
      // Both axes take the *same* factor, clamped together rather than each on
      // its own. Clamped separately, whichever axis reached its stop first
      // froze while the other kept going: zooming in became horizontal-only
      // once the time axis pinned, while zooming out freed it again straight
      // away, so the gesture did not undo itself. Holding one factor for both
      // keeps their ratio fixed, which makes zoom symmetric and exactly
      // reversible - wind it in and back out and you land where you started.
      //
      // COL_MIN and COL_MAX are the bounds for *fitting*; a deliberate gesture
      // is allowed past them, and the labels drop out by themselves once the
      // columns are too narrow to hold one.
      const room = (v, lo, hi) => (f >= 1 ? Math.min(f, hi / v) : Math.max(f, lo / v));
      const sRoom = room(cam.s, S_MIN, S_MAX);
      const cRoom = room(cam.cw, CW_MIN, CW_MAX);
      const g = f >= 1 ? Math.min(sRoom, cRoom) : Math.max(sRoom, cRoom);
      cam.s *= g;
      cam.cw *= g;
      cam.ty = py - wy * cam.s;      // keep the point under the cursor fixed
      cam.tx = px - lf * cam.cw;
      gliding = null;
      dirty = true;
    }, { passive: false });

    /** Is a crawling lineage tie on screen for the current selection? */
    function lineageAlive() {
      return [sel.focus, sel.a, sel.b, sel.hoverBranch].some((n) => {
        const b = n && branchInfo.get(n);
        return b && b.parents && b.parents.length;
      });
    }

    function frame(now) {
      // Clamped: a negative step would ease *away* from the target and throw
      // the columns off the canvas, and a huge one (a backgrounded tab coming
      // back) would snap every animation instead of resuming it.
      const dt = lastT ? Math.max(0, Math.min(now - lastT, 100)) : 16;
      lastT = now;
      if (gliding) gliding(now);
      animating = stepEasing(dt);
      if (sel.hover || spawn) animating = true;
      // The path pulses and the lineage ties crawl; an idle selection with
      // neither on screen lets the loop go back to sleep.
      if (path || lineageAlive()) animating = true;
      if (dirty || animating) { dirty = false; draw(now); }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    new ResizeObserver(() => { viewRect = null; resize(); }).observe(canvas);
    resize();

    return {
      setData, fit, focusBranch, focusOn, resize, markSpawn, setFilter,
      /** Mark commits a model helped write. */
      setAiHighlight(on) { showAi = !!on; dirty = true; },
      colorOf: (n) => css(colorOf(n)),
      heatCss: (v, isMain) => css(heat(v, isMain)),
      setSelection(next) {
        Object.assign(sel, next);
        // Clearing the selection releases a pinned branch too: one gesture,
        // one way back to the whole picture.
        if (focusPin && !sel.a && !sel.b && !sel.focus) focusPin = null;
        if (computePath()) {
          recomputeLaneTargets();   // a pick changes who gets the width
          // Reframe only when a pair is actually on the table. Doing it for
          // every single click would yank the camera each time you glanced at
          // a branch. Measured after the line above, never before it.
          if (path && sel.a && sel.b) {
            const ext = pathExtent();
            if (ext) frameOn(ext, true);
          }
        }
        dirty = true;
      },
      commit: (sha) => commitBySha.get(sha),
    };
  }

  return { create };
})();
