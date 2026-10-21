/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * Deploy on Customer, Released, Create/Edit/XEdit execution contexts.
 * Parameters: custscript_mbbs_customer_webhook_url (HTTPS URL),
 * custscript_mbbs_customer_webhook_secret (same as NETSUITE_WEBHOOK_SECRET).
 */
define(['N/record', 'N/runtime', 'N/https', 'N/log'], (record, runtime, https, log) => {
  function text(value) { return value === null || value === undefined ? '' : String(value).trim(); }
  function checked(value) { return value === true || value === 'T'; }

  function addresses(customer) {
    const result = [];
    const count = customer.getLineCount({ sublistId: 'addressbook' });
    for (let line = 0; line < count; line += 1) {
      const value = fieldId => customer.getSublistValue({ sublistId: 'addressbook', fieldId, line });
      const address = customer.getSublistSubrecord({ sublistId: 'addressbook', fieldId: 'addressbookaddress', line });
      const row = { netsuiteAddressId: text(value('internalid')), label: text(value('label')),
        billingDefault: checked(value('defaultbilling')), shippingDefault: checked(value('defaultshipping')), active: true };
      const fields = { addressee: 'addressee', attention: 'attention', addressLine1: 'addr1', addressLine2: 'addr2',
        addressLine3: 'addr3', city: 'city', region: 'state', postalCode: 'zip', countryCode: 'country', phone: 'addrphone' };
      Object.keys(fields).forEach(key => { row[key] = text(address.getValue({ fieldId: fields[key] })); });
      result.push(row);
    }
    return result;
  }

  function snapshot(customer) {
    const value = fieldId => customer.getValue({ fieldId });
    const currency = record.load({ type: record.Type.CURRENCY, id: value('currency'), isDynamic: false });
    const legalName = text(value('companyname')) || ['firstname', 'middlename', 'lastname'].map(field => text(value(field))).filter(Boolean).join(' ') || text(value('entityid'));
    const modified = value('lastmodifieddate');
    // Do not substitute send time: retries must retain source ordering.
    if (!modified || typeof modified.toISOString !== 'function') { throw new Error('Customer modification timestamp unavailable.'); }
    const subsidiaryId = text(value('subsidiary'));
    return { netsuiteId: String(customer.id), entityNumber: text(value('entityid')), legalName, displayName: legalName,
      currency: text(currency.getValue({ fieldId: 'symbol' })).toUpperCase(),
      email: text(value('email')), phone: text(value('phone')), active: !checked(value('isinactive')),
      terms: text(customer.getText({ fieldId: 'terms' })), taxStatus: text(value('taxitem')), creditStatus: text(value('creditholdoverride')),
      sourceModifiedAt: modified.toISOString(), addresses: addresses(customer),
      subsidiaries: subsidiaryId ? [{ netsuiteId: subsidiaryId, relationshipName: text(customer.getText({ fieldId: 'subsidiary' })), primary: true, active: true }] : [] };
  }

  function afterSubmit(context) {
    if (!['create', 'edit', 'xedit'].includes(context.type)) { return; }
    try {
      const script = runtime.getCurrentScript();
      const url = text(script.getParameter({ name: 'custscript_mbbs_customer_webhook_url' }));
      const secret = text(script.getParameter({ name: 'custscript_mbbs_customer_webhook_secret' }));
      if (!/^https:\/\//i.test(url) || !secret) {
        log.error({ title: 'MBBS customer webhook missing parameters', details: 'Configure the HTTPS customer webhook URL and shared secret.' });
        return;
      }
      // XEDIT newRecord contains only changed fields. Always load the saved record.
      const customer = record.load({ type: record.Type.CUSTOMER, id: context.newRecord.id, isDynamic: false });
      if (text(customer.getValue({ fieldId: 'stage' })).toUpperCase() !== 'CUSTOMER') { return; }
      const response = https.post({ url, headers: { 'Content-Type': 'application/json', 'x-mbbs-webhook-secret': secret },
        body: JSON.stringify({ schemaVersion: 'netsuite-customer/v1', recordType: 'customer', eventType: context.type,
          accountId: runtime.accountId, customer: snapshot(customer) }) });
      const code = Number(response.code);
      const details = { customerId: String(customer.id), eventType: context.type, status: code };
      if (code >= 200 && code < 300) { log.audit({ title: 'MBBS customer webhook sent', details }); }
      else { log.error({ title: 'MBBS customer webhook failed', details }); }
    } catch (_error) {
      // Never include response bodies, exception messages, credentials or customer data.
      log.error({ title: 'MBBS customer webhook exception', details: { customerId: String(context.newRecord.id), eventType: context.type } });
    }
  }
  return { afterSubmit };
});
