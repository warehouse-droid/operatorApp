/* global window, document */
(() => {
  function create({mount, active, detailSelector='.stock-request-detail', feedbackSelector='.stock-request-feedback'}) {
    let version = 0, pending = false, edits = 0;
    for (const type of ['input', 'change']) mount.addEventListener(type, event => {
      if (event.target.closest(detailSelector)) edits++;
    });
    function paint() {
      if (!active()) return;
      const feedback = mount.querySelector(feedbackSelector);
      if (!feedback) return;
      let notice = feedback.querySelector('[data-stock-background-update]');
      if (!pending) {notice?.remove();return;}
      if (!notice) {
        notice = document.createElement('div');
        notice.dataset.stockBackgroundUpdate = '';
        notice.className = 'stock-request-notice';
        notice.setAttribute('role', 'status');
        feedback.appendChild(notice);
      }
      const message = window.RegularStockUI?.t('Updates available. Use Refresh when you are ready.', '有更新。准备好后请点击刷新。')
        || 'Updates available. Use Refresh when you are ready.';
      if (notice.textContent !== message) notice.textContent = message;
    }
    return {
      paint,
      changed() {version++;pending = true;paint();},
      acknowledge(readVersion) {if (readVersion === version) {pending = false;paint();}},
      get version() {return version;},
      get editVersion() {return edits;},
      get pending() {return pending;}
    };
  }

  function renderDetail(mount, html, selectedId) {
    const panel = mount.querySelector('.stock-request-detail');
    if (!panel) return false;
    const sameRequest = panel.dataset.requestId === String(selectedId);
    const scroll = sameRequest ? panel.scrollTop : 0;
    panel.innerHTML = html;
    panel.dataset.requestId = String(selectedId);
    panel.scrollTop = scroll;
    for (const card of mount.querySelectorAll('.stock-request-card[data-id]')) {
      card.classList.toggle('selected', String(card.dataset.id) === String(selectedId));
    }
    return true;
  }

  function preserveScroll(mount) {
    const top = window.scrollY, left = window.scrollX;
    const panels = ['.stock-request-list', '.stock-request-detail'].map(selector => ({
      selector, top: mount.querySelector(selector)?.scrollTop || 0
    }));
    return () => {
      for (const panel of panels) {
        const element = mount.querySelector(panel.selector);
        if (element) element.scrollTop = panel.top;
      }
      window.scrollTo({top, left, behavior: 'instant'});
    };
  }

  function regularEventRelevant(event, requests) {
    if (event.type === 'stock-request.updated') return true;
    if (!['dispatch.orders.updated', 'driver.job.completed'].includes(event.type)) return false;
    const payload = event.payload || {};
    if (!payload.orderId && !payload.tranid && !payload.orderRefs) return true;
    const refs = [payload.tranid, ...(Array.isArray(payload.orderRefs) ? payload.orderRefs : [])].filter(Boolean);
    return requests.some(request => {
      const orders = [request.regular || {}, ...(request.transfers || [])];
      return orders.some(order => [order.salesOrderId, order.netsuiteTransferOrderId].some(id => id && String(id) === String(payload.orderId))
        || [order.salesOrderRef, order.netsuiteTransferOrderRef].some(ref => ref && refs.includes(ref)));
    });
  }

  function setError(mount, message, feedbackSelector='.stock-request-feedback') {
    const feedback = mount.querySelector(feedbackSelector);
    if (!feedback) return;
    feedback.querySelectorAll('[data-stock-detail-error],.stock-request-error').forEach(node => node.remove());
    if (!message) return;
    const error = document.createElement('div');
    error.dataset.stockDetailError = '';
    error.className = 'stock-request-notice stock-request-error';
    error.setAttribute('role', 'alert');
    error.textContent = message;
    feedback.appendChild(error);
  }

  window.StockRequestView = {create, renderDetail, preserveScroll, regularEventRelevant, setError};
})();
