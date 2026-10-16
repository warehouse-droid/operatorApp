/* Background refreshes never count as human activity. */
window.DispatchEditActivity = {
  create({ isEditing, onIdle, onActivity = () => {}, now = () => Date.now() }) {
    const idleLimitMs = 10 * 60 * 1000;
    let lastActivityAt = now(), lastReportedAt = -Infinity, timer = null, running = false;
    const ageMs = () => Math.max(0, now() - lastActivityAt);
    function stop() {
      running = false;
      window.clearInterval(timer);
      timer = null;
    }
    function check() {
      if (!running || ageMs() < idleLimitMs) {return false;}
      stop();
      onIdle();
      return true;
    }
    function record(event) {
      if (!running || !event.isTrusted || check() || !isEditing()) {return;}
      lastActivityAt = now();
      if (now() - lastReportedAt >= 5000) {
        lastReportedAt = now();
        onActivity();
      }
    }
    for (const name of ['pointermove', 'pointerdown', 'keydown', 'input', 'touchstart', 'touchmove', 'wheel']) {
      window.addEventListener(name, record, { capture: true, passive: true });
    }
    return {
      ageMs, stop, isIdle: () => ageMs() >= idleLimitMs,
      start(activityAt = now()) {
        stop();
        lastActivityAt = Number.isFinite(activityAt) ? Math.min(activityAt, now()) : now();
        lastReportedAt = -Infinity;
        running = true;
        if (!check()) {timer = window.setInterval(check, 1000);}
      }
    };
  }
};
