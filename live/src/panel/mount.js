/**
 * Panel mount lifecycle: the Appearance (外观) page anchor, mount/unmount
 * loop, legacy sweep and the serve health heartbeat.
 *
 *   - mounts ONLY while the Appearance page is visible: all settings tabs
 *     share one React-managed container, and a foreign child survives tab
 *     switches — the section is removed the moment the Appearance heading is
 *     off screen (synchronously, before paint) and remounts when it returns
 *   - heartbeat hard/soft contract: hard = connection REFUSED (serve really
 *     gone) → retire within ~10s; soft = timeout while serve is busy → never
 *     retires; latched on first success so cold start doesn't count; revives
 *     when health returns
 */

export const MARKER = "zcode-wallpaper-settings-v6";
export const LEGACY_IDS = ["zcode-wallpaper-settings", "zcode-wallpaper-settings-2"];
const H2_TEXT = /^(外观|Appearance)$/;

/** The Appearance settings page's section list, only while it is the active
 *  tab. Other settings pages carry their own visible "外观" heading in an
 *  identical layout; the real Appearance page also contains 界面主题. */
export function appearanceSectionList() {
  const h2 = Array.prototype.find.call(document.querySelectorAll("h2"), function (h) {
    return H2_TEXT.test((h.textContent || "").trim()) && h.offsetParent !== null;
  });
  if (!h2) return null;
  const main = h2.closest("main");
  const col = main && main.querySelector(".max-w-4xl");
  if (!col || !col.contains(h2)) return null;
  if (!/(界面主题|Interface theme|界面主題)/.test(col.textContent || "")) return null;
  return col.querySelector(".space-y-8") || col;
}

export function createMountLoop({ API, reg, buildSection }) {
  let scheduled = false;
  let hbRetired = false;
  let hbHard = 0;
  let hbSoft = 0;
  let hbSeen = false;
  let resetUi = function () {};

  function sweepLegacy() {
    LEGACY_IDS.forEach(function (id) {
      const e = document.getElementById(id);
      if (e) e.remove();
    });
  }

  // Leaving the Appearance tab: the shared container keeps foreign children,
  // so the section must be removed SYNCHRONOUSLY here — MutationObserver
  // callbacks run before paint, while the debounced scan (80ms) would leave
  // the section visible over the new tab for a few frames (visible flash).
  function onMutations() {
    const mine = document.getElementById(MARKER);
    if (mine && !appearanceSectionList()) {
      mine.remove();
      resetUi();
    }
    schedule();
  }
  function scan() {
    scheduled = false;
    if (hbRetired) return; // serve is gone — no stale panel without data
    const mine = document.getElementById(MARKER);
    const host = appearanceSectionList();
    if (!host) {
      if (mine) mine.remove(); // belt and braces; the sync path usually got here first
      resetUi();
      return;
    }
    if (mine) return; // mounted and current
    sweepLegacy();
    resetUi();
    buildSection(host);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    reg.timer(scan, 80);
  }

  function start() {
    const mountObserver = new MutationObserver(onMutations);
    mountObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    reg.observer(mountObserver);
    // Safety rescan: React re-renders of the settings page can transiently
    // replace the host container, taking the section with it; when the
    // appearance page is back but the section is not, requiring another DOM
    // mutation to remount reads as "the box disappeared until I clicked".
    reg.every(function () {
      if (hbRetired) return;
      if (document.getElementById(MARKER)) return;
      if (!appearanceSectionList()) return;
      schedule();
    }, 2000);

    // Lifecycle heartbeat.
    reg.every(function () {
      const t0 = Date.now();
      fetch(API + "/api/health", { signal: AbortSignal.timeout(2500) })
        .then(function (r) { return r.json(); })
        .then(function (b) {
          if (!b || b.service !== "zcode-wallpaper") throw 0;
          const revive = hbRetired || !hbSeen;
          hbSeen = true;
          hbHard = 0;
          hbSoft = 0;
          hbRetired = false;
          if (revive) schedule(); // serve just came up (or back) — (re)mount
        })
        .catch(function () {
          if (!hbSeen) return; // cold-start race: keep waiting for the serve
          const hard = (Date.now() - t0) < 150;
          if (hard) { hbHard++; hbSoft = 0; } else { hbSoft++; hbHard = 0; }
          if (hbHard < 2 && hbSoft < 6) return;
          hbHard = 0;
          hbSoft = 0;
          hbRetired = true;
          const mine = document.getElementById(MARKER);
          if (mine) mine.remove();
        });
    }, 5000);

    sweepLegacy();
    scan();
  }

  return {
    start,
    schedule,
    get retired() { return hbRetired; },
    onResetUi(fn) { resetUi = fn; },
    teardown() {
      hbRetired = true;
      [MARKER, MARKER + "-range-style"].forEach(function (id) {
        const n = document.getElementById(id);
        if (n) n.remove();
      });
    },
  };
}
