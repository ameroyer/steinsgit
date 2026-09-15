/* Nixie Divergence Meter.
   Eight tubes: one integer digit, a decimal point, six fractional digits.
   Changing the value spins each tube and settles them left to right, which is
   the whole reason the thing feels like a Divergence Meter and not a label. */

const Meter = (() => {
  const SPIN_MS = 46;          // how fast a spinning tube cycles digits
  const SETTLE_STAGGER = 85;   // delay added per tube position
  const SETTLE_BASE = 260;

  let root = null;
  let tubes = [];              // {el, glyph, isDot, timer}
  let current = "0.000000";
  let generation = 0;

  function mount(el) {
    root = el;
    root.innerHTML = "";
    tubes = [];
    for (const ch of "0.000000") {
      const isDot = ch === ".";
      const tube = document.createElement("div");
      tube.className = "tube" + (isDot ? " dot" : "");
      const glyph = document.createElement("div");
      glyph.className = "glyph";
      glyph.textContent = isDot ? "." : "0";
      const mesh = document.createElement("div");
      mesh.className = "mesh";
      tube.append(glyph, mesh);
      root.appendChild(tube);
      tubes.push({ el: tube, glyph, isDot, timer: null });
    }
  }

  function set(display, opts = {}) {
    if (!root) return;
    display = String(display);
    if (display.length !== 8) display = "0.000000";

    root.classList.toggle("crit", parseFloat(display) >= 1.25);
    root.classList.toggle("sg", display === "1.048596");

    const spin = opts.spin !== false && display !== current;
    current = display;

    const gen = ++generation;
    tubes.forEach((tube, i) => {
      if (tube.timer) { clearInterval(tube.timer); tube.timer = null; }
      const target = display[i];
      if (tube.isDot) { tube.glyph.textContent = "."; return; }
      if (!spin || prefersReduced()) {
        tube.el.classList.remove("spinning");   // a spin() may still be going
        tube.glyph.textContent = target;
        return;
      }

      tube.el.classList.add("spinning");
      tube.timer = setInterval(() => {
        tube.glyph.textContent = String((Math.random() * 10) | 0);
      }, SPIN_MS);

      setTimeout(() => {
        if (gen !== generation) return;   // a newer value superseded this spin
        clearInterval(tube.timer);
        tube.timer = null;
        tube.el.classList.remove("spinning");
        tube.glyph.textContent = target;
      }, SETTLE_BASE + i * SETTLE_STAGGER);
    });
  }

  /** Spin every tube until the next set(): the meter's way of saying that a
   *  measurement is in flight rather than showing the previous pair's value. */
  function spin() {
    if (!root || prefersReduced()) return;
    generation++;
    for (const tube of tubes) {
      if (tube.timer) { clearInterval(tube.timer); tube.timer = null; }
      if (tube.isDot) continue;
      tube.el.classList.add("spinning");
      tube.timer = setInterval(() => {
        tube.glyph.textContent = String((Math.random() * 10) | 0);
      }, SPIN_MS);
    }
  }

  function prefersReduced() {
    return window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  return { mount, set, spin };
})();
