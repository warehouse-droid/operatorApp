(() => {
  function paint(card, value) {
    const count = Number(value);
    let badge = card.querySelector('[data-request-unread-badge]');
    if (!Number.isSafeInteger(count) || count <= 0) {
      badge?.remove();
      card.classList.remove('request-unread-card');
      return;
    }
    card.classList.add('request-unread-card');
    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.requestUnreadBadge = '';
      badge.className = 'request-unread-badge';
      card.append(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
    const label = `${count} unread message${count === 1 ? '' : 's'}`;
    badge.setAttribute('aria-label', label);
    badge.title = label;
  }
  window.MBBSRequestUnreadBadge = {paint};
})();
