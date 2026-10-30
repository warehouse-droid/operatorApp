/* global window */
(() => {
  function create({ request, context }) {
    const pending = new Map();
    const recorded = new Set();
    let running = false;
    let retryTimer = null;

    const scope = () => JSON.stringify(context());
    const remember = key => {
      recorded.add(key);
      if (recorded.size > 2000) { recorded.delete(recorded.values().next().value); }
    };

    async function send(key, entry) {
      if (entry.scope !== scope()) { pending.delete(key); return; }
      try {
        await request(entry.body);
        pending.delete(key);
      } catch (error) {
        entry.attempts += 1;
        if (entry.attempts >= 3 || (error.status >= 400 && error.status < 500)) {
          pending.delete(key);
          console.warn('Operator popup audit could not be saved.', error.status || 'network');
        }
      }
    }

    async function flush() {
      if (running) { return; }
      running = true;
      window.clearTimeout(retryTimer);
      try {
        for (const [key, entry] of pending) { await send(key, entry); }
      } finally {
        running = false;
        if (pending.size) { retryTimer = window.setTimeout(() => { void flush(); }, 1000); }
      }
    }

    function record(action, items, visibility) {
      const current = context();
      if (!current.actorId || !current.locationId) { return; }
      for (const item of items) {
        const key = `${item.popupId}:${action}`;
        if (!item.popupId || recorded.has(key) || item.popupScope !== scope()) { continue; }
        remember(key);
        const body = {
          popupId: item.popupId, action, orderId: String(item.orderId), locationId: current.locationId,
          notificationKey: item.notificationKey, clientTime: new Date().toISOString(), visibility,
          notificationPermission: window.Notification?.permission || 'unsupported',
          planDate: item.dispatchPlanDate || '', truck: item.truck || '', load: item.load || '', parkingSpot: item.parkingSpot || ''
        };
        if (pending.size >= 200) { pending.delete(pending.keys().next().value); }
        pending.set(key, { body, scope: scope(), attempts: 0 });
      }
      void flush();
    }
    return { record, scope };
  }
  window.MBBSOperatorPopupAudit = { create };
})();
