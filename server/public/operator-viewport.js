(function () {
  "use strict";
  const agent = /** @type {Navigator & {userAgentData?: {platform?: string}}} */ (navigator);
  // Android tablets can identify as Linux when Chrome uses desktop mode.
  const android = /Android/i.test(agent.userAgent)
    || agent.userAgentData?.platform === "Android"
    || (agent.maxTouchPoints > 0
      && (/Linux/i.test(agent.userAgent) || agent.userAgentData?.platform === "Linux"));
  if (!android) return;

  const root = document.documentElement;
  const app = document.getElementById("app");
  const standalone = window.matchMedia("(display-mode: standalone)");
  const viewport = window.visualViewport;
  const storageKey = "mbbs.operator.safe-viewport";
  const launchHeights = new Map();
  /** @type {{key: string, height: number} | null} */
  let savedLaunch = null;
  let frame = 0;

  // The reported M10T layout works after reopening, then moves behind its bar.
  // Retain the working launch boundary across page reloads in that window.
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (saved && typeof saved.key === "string" && Number.isFinite(saved.height) && saved.height > 0) {
      savedLaunch = saved;
    }
  } catch { /* Height protection still works in memory when storage is blocked. */ }

  function update() {
    frame = 0;
    if (!standalone.matches) {
      delete root.dataset.androidViewport;
      root.style.removeProperty("--operator-visible-height");
      return;
    }
    root.dataset.androidViewport = "true";
    if (document.visibilityState === "hidden") return;

    const usable = [window.innerHeight, root.clientHeight].filter(value => Number.isFinite(value) && value > 0);
    if (!usable.length) return;
    const key = [screen.width, screen.height, screen.orientation?.type, window.innerWidth, window.devicePixelRatio].join(":");
    if (!launchHeights.has(key)) {
      const previous = savedLaunch?.key === key ? savedLaunch.height : Infinity;
      launchHeights.set(key, Math.floor(Math.min(...usable, previous)));
    }
    const launchHeight = launchHeights.get(key);
    try { sessionStorage.setItem(storageKey, JSON.stringify({ key, height: launchHeight })); }
    catch { /* Keep the in-memory launch limit. */ }

    usable.push(launchHeight);
    // Do not save keyboard shrinkage or turn pinch zoom into a smaller layout.
    if (viewport && Math.abs(viewport.scale - 1) < 0.01 && viewport.height > 0) usable.push(viewport.height);
    const height = `${Math.floor(Math.min(...usable))}px`;
    if (root.style.getPropertyValue("--operator-visible-height") !== height) {
      root.style.setProperty("--operator-visible-height", height);
    }
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  // Keep viewport state outside #app so replacing a screen cannot remove it.
  if (app) new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
  for (const event of ["resize", "orientationchange", "pageshow", "focus"]) {
    window.addEventListener(event, schedule);
  }
  document.addEventListener("visibilitychange", schedule);
  viewport?.addEventListener("resize", schedule);
  standalone.addEventListener("change", schedule);
  update();
})();
