/**
 * Auto-heal opaque surfaces (Zgd03 model, D9).
 *
 * ZCode updates rename internal classes; copied-class overrides then miss and
 * opaque cards cover the wallpaper (the recurring bare-css bug class).
 * Version-proof DOM-level fallback: scan bg-background surfaces, force-
 * translucent any opaque one covering >=30% of the viewport (skips dialogs/
 * menus/popovers), mark with an attr, recycle marks when layouts change.
 */

const WP_AUTO = "data-zw-auto";

export function createHeal(reg, rec) {
  let installed = false;
  function heal() {
    try {
      const vp = window.innerWidth * window.innerHeight;
      const nodes = document.querySelectorAll("[class*=bg-background]");
      const keep = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.closest("[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]")) continue;
        const r = n.getBoundingClientRect();
        if (r.width * r.height < vp * 0.3) continue;
        const bg = getComputedStyle(n).backgroundColor;
        const opaque = !(bg === "transparent" || bg === "rgba(0, 0, 0, 0)");
        if (!n.hasAttribute(WP_AUTO) && !opaque) continue;
        keep.push(n);
      }
      const marked = document.querySelectorAll("[" + WP_AUTO + "]");
      for (let m = 0; m < marked.length; m++) {
        if (keep.indexOf(marked[m]) === -1) marked[m].removeAttribute(WP_AUTO);
      }
      let added = 0;
      for (let k = 0; k < keep.length; k++) {
        if (!keep[k].hasAttribute(WP_AUTO)) { keep[k].setAttribute(WP_AUTO, ""); added++; }
        keep[k].style.setProperty("background-color", "var(--color-background)", "important");
      }
      if (added > 0) rec("AUTOHEAL", added + " surface(s)");
    } catch (e) { /* never break the runtime */ }
  }
  return {
    start() {
      if (installed) return;
      installed = true;
      heal();
      reg.every(heal, 5000);
      // Reactive pass: the 5s poll left a window where a freshly mounted
      // route surface (opening Settings) sat OPAQUE over the wallpaper —
      // "click settings, everything dims, then suddenly clears" was exactly
      // that wait. Any DOM/class change schedules an immediate pass
      // (rAF-coalesced, 150ms trailing throttle — mount animations churn).
      let pending = null;
      let last = 0;
      const schedule = function () {
        const now = Date.now();
        if (pending) return;
        const wait = Math.max(0, 150 - (now - last));
        pending = setTimeout(function () {
          pending = null;
          last = Date.now();
          requestAnimationFrame(heal);
        }, wait);
      };
      try {
        const obs = new MutationObserver(schedule);
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        reg.observer(obs);
      } catch (e) { /* the 5s poll still covers us */ }
    },
  };
}
