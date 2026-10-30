(() => {
  const states = new Map();
  let options;
  const stateFor = key => {
    const id = String(key);
    if (!states.has(id)) { states.set(id, { recipient: '', busy: false, status: '', title: '', message: '' }); }
    return states.get(id);
  };
  function posted(record) {
    return record && record.status !== 'voided' && !record.voidedAt
      && ['succeeded', 'manual_linked'].includes(record.netSuiteSyncStatus)
      && ['credit_memo', 'return_authorization'].includes(record.netSuiteStage)
      && Number(record.netSuiteTransactionId) > 0 && String(record.netSuiteTransactionRef || '').trim();
  }
  function hydrateAutomaticNotification(records, key) {
    if (!states.has(key)) {
      const automatic = records[0].customerNotification;
      const state = stateFor(key);
      state.recipient = automatic?.recipient || records[0].customerPhone || records[0].customerEmail || '';
      if (automatic) {
        state.status = automatic.status;
        state.title = statusTitle(automatic);
        state.message = statusMessage(automatic, state.recipient);
      }
    }
  }
  function html(records) {
    if (!records.length || !records.every(posted)) { return ''; }
    const key = String(records[0].batchId || records[0].id);
    hydrateAutomaticNotification(records, key);
    const state = stateFor(key);
    const escape = options.escapeHtml;
    const references = [...new Set(records.map(record => record.netSuiteTransactionRef))].join(', ');
    return `<section class="return-customer-notification" aria-label="Send return confirmation">
      <h3>Send return confirmation</h3>
      <p>Send the customer their NetSuite Credit Memo / RA number: <strong>${escape(references)}</strong>.</p>
      <div id="return-notification-status-${escape(key)}" class="return-notification-status" data-status="${escape(state.status)}"
        role="status" aria-live="polite" aria-atomic="true" ${state.message ? '' : 'hidden'}>
        <strong>${state.status === 'sent' ? '<span aria-hidden="true">✓</span> ' : ''}${escape(state.title)}</strong>
        <span>${escape(state.message)}</span>
      </div>
      <label class="return-field"><span>Email or mobile number</span>
        <input type="text" data-return-notification-recipient="${escape(key)}" value="${escape(state.recipient)}"
          placeholder="customer@example.com or 4165550123" maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false" ${state.busy ? 'disabled' : ''} />
      </label>
      <small>Email or SMS is selected automatically. Canada/US: enter 10 digits; we add +1 automatically. For other countries, include +country code.</small>
      <button class="primary-button" data-action="return-notification-send" data-notification-key="${escape(key)}"
        data-record="${escape(records[0].id)}" type="button" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Sending…' : 'Send'}</button>
    </section>`;
  }
  function input(key, value) {
    const state = stateFor(key);
    state.recipient = value;
    state.status = '';
    state.title = '';
    state.message = '';
    const feedback = window.document?.getElementById(`return-notification-status-${key}`);
    if (feedback) { feedback.hidden = true; }
  }
  function statusTitle(result) {
    if (['pending', 'processing', 'retry'].includes(result.status)) { return 'Automatic confirmation pending'; }
    if (result.status === 'no_contact') { return 'Customer contact unavailable'; }
    if (result.status === 'cancelled') { return 'Automatic confirmation cancelled'; }
    if (result.status === 'sent') {
      return `${result.channel === 'sms' ? 'SMS' : 'Email'} ${result.replayed ? 'already sent' : 'sent successfully'}`;
    }
    if (result.status === 'sending') { return 'Message is being sent'; }
    return result.status === 'failed' ? 'Message not sent' : 'Delivery status unknown';
  }
  function statusMessage(result, recipient) {
    if (['pending', 'processing', 'retry'].includes(result.status)) { return 'The return is posted. Customer confirmation will be sent automatically using the NetSuite contact.'; }
    if (result.status === 'no_contact') { return 'NetSuite has no usable phone or email for this customer. Enter a contact below to send the confirmation.'; }
    if (result.status === 'cancelled') { return 'This return is no longer eligible for an automatic confirmation.'; }
    if (result.status === 'sent') {
      return `To ${result.recipient || recipient.trim()}. Customer delivery may take a moment.`;
    }
    if (result.status === 'sending') { return 'This message is already being processed. Check again shortly.'; }
    if (result.status === 'failed') { return 'The service rejected this message. Check the recipient and ask an administrator to check the settings before trying again.'; }
    return 'Delivery outcome is unknown. Ask an administrator to check the email/Telnyx logs before sending again.';
  }
  async function send(key, recordId) {
    const state = stateFor(key);
    if (state.busy) { return; }
    if (!state.recipient.trim()) {
      state.status = 'failed';
      state.title = 'Message not sent';
      state.message = 'Enter one email address or mobile number.';
      return options.render();
    }
    state.busy = true;
    state.status = '';
    state.title = '';
    state.message = '';
    options.render();
    try {
      const result = await options.request(`/api/returns/operator/history/${encodeURIComponent(recordId)}/notify`, {
        method: 'POST', body: JSON.stringify({ recipient: state.recipient })
      });
      state.status = result.status;
      state.title = statusTitle(result);
      state.message = statusMessage(result, state.recipient);
    } catch (error) {
      state.status = 'uncertain';
      state.title = 'Unable to confirm sending';
      state.message = error.message || 'Check the connection before trying again.';
    } finally {
      state.busy = false;
      options.render();
      window.document?.getElementById(`return-notification-status-${key}`)?.scrollIntoView({ block: 'nearest' });
    }
  }
  window.MBBSReturnNotifications = { configure: value => { options = value; }, html, input, send,
    clear: () => { states.clear(); } };
})();
