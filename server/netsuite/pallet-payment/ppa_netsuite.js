/**
 * @NApiVersion 2.1
 */
define(['N/query', 'N/record', 'N/search', 'N/runtime', './ppa_core', './ppa_config'],
  (query, record, search, runtime, core, config) => {
    'use strict';
    const A = config.allocationFields;
    const R = config.refundFields;
    const checked = value => value === true || value === 'T';
    const field = (rec, name) => rec.getValue({ fieldId: name });
    const lineValue = (rec, sublistId, name, line) => rec.getSublistValue({ sublistId, fieldId: name, line });
    const id = value => {
      const text = String(value);
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) { throw new Error('INVALID_INTERNAL_ID'); }
      return text;
    };
    function usage(minimum) {
      if (runtime.getCurrentScript().getRemainingUsage() < minimum) { throw new Error('CUSTOMER_TOO_LARGE_FOR_SAFE_REBUILD'); }
    }
    function rows(sql, params) {
      usage(150);
      const paged = query.runSuiteQLPaged({ query: sql, params, pageSize: 1000 });
      if (paged.count > config.maxRows) { throw new Error('CUSTOMER_QUERY_LIMIT_REVIEW'); }
      return paged.pageRanges.flatMap(page => paged.fetch({ index: page.index }).data.asMappedResults());
    }
    function searchRows(type, filters, columns) {
      const orderedColumns = columns.map(name => name === 'internalid' ? search.createColumn({ name, sort: search.Sort.ASC }) : name);
      const result = search.create({ type, filters, columns: orderedColumns }).runPaged({ pageSize: 1000 });
      if (result.count > config.maxRows) { throw new Error('CUSTOMER_SEARCH_LIMIT_REVIEW'); }
      return result.pageRanges.flatMap(page => result.fetch({ index: page.index }).data).map(row => {
        const value = {};
        for (const column of columns) { value[column] = row.getValue({ name: column }); }
        return value;
      });
    }
    function customerGroups(type, filters, customerField) {
      const column = search.createColumn({ name: customerField, summary: search.Summary.GROUP, sort: search.Sort.ASC });
      const required = [customerField, 'noneof', '@NONE@'];
      const expression = filters.length ? [...filters, 'and', required] : [required];
      const paged = search.create({ type, filters: expression, columns: [column] }).runPaged({ pageSize: 1000 });
      // Group/sort by customer for unique paging. Discovery is not subject to the per-customer row limit.
      return paged.pageRanges.flatMap(page => paged.fetch({ index: page.index }).data.map(row => id(row.getValue(column))));
    }
    function customers(target) {
      if (target) { return [id(target)]; }
      // Native SuiteQL UNION paging failed in this account. Keep the two supported searches separate.
      const fromTransactions = customerGroups('transaction', [
        ['type', 'anyof', ['CustInvc', 'CustCred']], 'and', ['item', 'anyof', config.item]
      ], 'entity');
      const fromLedger = customerGroups(config.allocationType, [], A.customer);
      return [...new Set([...fromTransactions, ...fromLedger])].sort((a, b) => Number(a) - Number(b));
    }
    function metadata(customer) {
      return rows(`SELECT t.id,t.type,t.entity,t.currency,t.paymentmethod,t.memo,t.foreigntotal,t.posting,t.status,
        h.subsidiary,TO_CHAR(t.trandate,'YYYY-MM-DD') AS docdate,
        TO_CHAR(t.lastmodifieddate,'YYYY-MM-DD HH24:MI:SS') AS modified
        FROM transaction t JOIN transactionline h ON h.transaction=t.id AND h.mainline='T'
        WHERE t.entity=? AND NVL(t.voided,'F')='F'
        AND (t.type IN ('CustPymt','CustRfnd','CustDep','DepAppl') OR
        (t.type IN ('CustInvc','CustCred') AND EXISTS (SELECT 1 FROM transactionline l
        WHERE l.transaction=t.id AND l.item=? AND l.iscogs='F' AND l.taxline='F')))
        ORDER BY t.id`, [Number(id(customer)), Number(config.item)]);
    }
    function links(customer) {
      return rows(`SELECT l.previousdoc AS invoice,l.nextdoc AS payment,t.type AS paymenttype,l.nextline,l.foreignamount
        FROM NextTransactionLineLink l JOIN transaction t ON t.id=l.nextdoc
        JOIN transaction i ON i.id=l.previousdoc
        WHERE t.entity=? AND t.type IN ('CustPymt','DepAppl','CustCred') AND i.type='CustInvc'
        AND NVL(t.voided,'F')='F' AND NVL(i.voided,'F')='F'
        AND l.previousline=0 AND l.linktype='Payment'
        ORDER BY l.previousdoc,l.nextdoc,l.nextline`, [Number(id(customer))]);
    }
    function sourceLines(customer) {
      return rows(`SELECT t.id AS invoice,l.uniquekey AS linekey,s.id AS so
        FROM transaction t JOIN transactionline l ON l.transaction=t.id
        LEFT JOIN transaction s ON s.id=l.createdfrom AND s.type='SalesOrd'
        WHERE t.entity=? AND t.type='CustInvc' AND NVL(t.voided,'F')='F'
        AND l.item=? AND l.iscogs='F' AND l.taxline='F'
        ORDER BY t.id,l.uniquekey`, [Number(id(customer)), Number(config.item)]);
    }
    function existing(customer) {
      const values = searchRows(config.allocationType, [[A.customer, 'anyof', id(customer)]],
        ['internalid', 'externalid', ...Object.values(A)]);
      const allocations = values.filter(row => String(row.externalid).startsWith('PPA1-')).map(row => ({
        id: String(row.internalid), key: String(row.externalid), qty: Number(row[A.qty] || 0),
        rate: core.money(row[A.rate] || 0), pending: Number(row[A.pending] || 0), refunded: Number(row[A.refunded] || 0),
        sources: String(row[A.sources] || '').split(',').filter(Boolean).sort()
      }));
      const refunds = searchRows(config.refundType, [search.createFilter({ name: A.customer, join: R.allocationId,
        operator: 'anyof', values: [id(customer)] })],
        ['internalid', 'externalid', ...Object.values(R)]);
      const events = refunds.filter(row => String(row.externalid).startsWith('PRA1-')).map(row => ({
        key: String(row.externalid), id: String(row.internalid)
      }));
      const manual = refunds.filter(row => !String(row.externalid).startsWith('PRA1-')).map(row => ({
        id: String(row.internalid), allocation: allocations.find(a => a.id === String(row[R.allocationId]))?.key || '',
        credit: String(row[R.credit] || ''), refund: String(row[R.refund] || ''), returnRef: String(row[R.returnRef] || ''),
        qty: Number(row[R.qty]), amount: core.money(row[R.amount] || 0), status: String(row[R.status] || '')
      }));
      return { allocations, events, manual };
    }
    function physical(customer) {
      const saved = search.load({ id: config.physicalSearch });
      const filter = ['entity', 'anyof', id(customer)];
      saved.filterExpression = saved.filterExpression?.length ? [saved.filterExpression, 'and', filter] : [filter];
      const cols = saved.columns.filter(c => c.name === 'quantity' && String(c.summary).toUpperCase() === 'SUM' && !c.join && !c.formula);
      if (cols.length !== 1) { throw new Error('PHYSICAL_SEARCH_SCHEMA_CHANGED'); }
      const found = saved.run().getRange({ start: 0, end: 2 });
      if (found.length > 1) { throw new Error('PHYSICAL_SEARCH_MULTIPLE_GROUPS'); }
      const quantity = found.length ? Number(found[0].getValue(cols[0])) : 0;
      if (!Number.isSafeInteger(quantity)) { throw new Error('INVALID_PHYSICAL_BALANCE'); }
      return quantity;
    }
    function basis(customer) {
      const docs = metadata(customer);
      const applications = links(customer).filter(link => docs.find(doc => String(doc.id) === String(link.payment))?.type !== 'DepAppl');
      applications.push(...depositApplications(docs));
      applications.sort((a, b) => Number(a.invoice) - Number(b.invoice) || Number(a.payment) - Number(b.payment) || Number(a.nextline) - Number(b.nextline));
      const lineSources = sourceLines(customer);
      const current = existing(customer);
      const balance = physical(customer);
      const stamp = JSON.stringify({ docs, applications, lineSources, manual: current.manual, balance });
      return { docs, applications, lineSources, current, balance, stamp };
    }
    function depositApplications(docs) {
      const result = [];
      for (const meta of docs.filter(doc => doc.type === 'DepAppl')) {
        usage(250);
        const rec = record.load({ type: 'depositapplication', id: id(meta.id), isDynamic: false });
        const deposit = id(field(rec, 'deposit'));
        for (let index = 0; index < rec.getLineCount({ sublistId: 'apply' }); index += 1) {
          if (!checked(lineValue(rec, 'apply', 'apply', index))) { continue; }
          result.push({ invoice: id(lineValue(rec, 'apply', 'doc', index)), payment: String(meta.id),
            paymenttype: 'DepAppl', nextline: index, deposit, foreignamount: lineValue(rec, 'apply', 'amount', index) });
        }
      }
      return result;
    }
    function readTax(rec, index, quantity, netAmount) {
      const tax2 = lineValue(rec, 'item', 'taxrate2', index);
      if (Number(String(tax2 || 0).replace('%', '')) !== 0) { throw new Error('SECOND_TAX_REQUIRES_REVIEW'); }
      const raw = lineValue(rec, 'item', 'taxrate1', index);
      if (raw === '' || raw === null || raw === undefined) { throw new Error('MISSING_LINE_TAX'); }
      const percent = Number(String(raw).replace('%', ''));
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) { throw new Error('INVALID_LINE_TAX'); }
      const tax = Math.round(netAmount * percent / 100);
      const gross = (netAmount + tax) / quantity;
      if (!Number.isSafeInteger(gross)) { throw new Error('NONUNIFORM_UNIT_TAX_REVIEW'); }
      return gross;
    }
    function palletLine(rec, index) {
      const qty = Number(lineValue(rec, 'item', 'quantity', index));
      const netAmount = core.money(lineValue(rec, 'item', 'amount', index));
      if (!Number.isSafeInteger(qty) || qty <= 0 || netAmount % qty !== 0) { throw new Error('NONSTANDARD_PALLET_LINE'); }
      return { line: id(lineValue(rec, 'item', 'lineuniquekey', index)), qty,
        net: netAmount / qty, gross: readTax(rec, index, qty, netAmount), so: '' };
    }
    function loadDocument(meta) {
      usage(250);
      const rec = record.load({ type: meta.type === 'CustInvc' ? 'invoice' : 'creditmemo', id: id(meta.id), isDynamic: false });
      if (Number(field(rec, 'discounttotal') || 0) !== 0) { throw new Error(`DISCOUNT_REVIEW:${meta.id}`); }
      const doc = { id: id(meta.id), customer: id(meta.entity), subsidiary: id(meta.subsidiary), currency: id(meta.currency),
        date: meta.docdate, so: '', lines: [], mixed: false };
      for (let index = 0; index < rec.getLineCount({ sublistId: 'item' }); index += 1) {
        if (String(lineValue(rec, 'item', 'item', index)) === config.item) { doc.lines.push(palletLine(rec, index)); }
        else if (Number(lineValue(rec, 'item', 'amount', index) || 0) !== 0) { doc.mixed = true; }
      }
      if (doc.lines.length === 0) { throw new Error(`PALLET_LINES_MISSING:${meta.id}`); }
      return doc;
    }
    function creditDocument(doc) {
      if (doc.lines.some(line => line.net !== doc.lines[0].net || line.gross !== doc.lines[0].gross)) {
        throw new Error(`MULTIPLE_CREDIT_RATES_REVIEW:${doc.id}`);
      }
      return { ...doc, qty: doc.lines.reduce((total, line) => total + line.qty, 0),
        net: doc.lines[0].net, gross: doc.lines[0].gross, refunds: [] };
    }
    function memo(meta) {
      const override = config.cardOverrides[meta.id];
      if (!override) { return String(meta.memo || ''); }
      if (override.method !== String(meta.paymentmethod) || !/^\d{4}$/.test(override.last4) || !override.evidence) {
        throw new Error(`INVALID_CARD_OVERRIDE:${meta.id}`);
      }
      return `${core.methods[override.method]} ****${override.last4}`;
    }
    function origin(meta, docs, depositId) {
      if (meta.type === 'CustPymt') { return meta; }
      const deposit = docs.find(doc => String(doc.id) === String(depositId) && doc.type === 'CustDep');
      if (!deposit) { throw new Error(`DEPOSIT_SOURCE_MISSING:${meta.id}`); }
      if (deposit.entity !== meta.entity || deposit.currency !== meta.currency || deposit.subsidiary !== meta.subsidiary) {
        throw new Error(`DEPOSIT_SCOPE_MISMATCH:${meta.id}`);
      }
      return deposit;
    }
    function funding(data) {
      const origins = new Map();
      const totalBySource = new Map();
      const payments = data.applications.filter(link => link.paymenttype !== 'CustCred').map(link => {
        const meta = data.docs.find(doc => String(doc.id) === String(link.payment));
        if (!meta || !checked(meta.posting)) { throw new Error(`PAYMENT_NOT_POSTED:${link.payment}`); }
        if (!origins.has(String(meta.id))) { origins.set(String(meta.id), origin(meta, data.docs, link.deposit)); }
        const source = origins.get(String(meta.id));
        const amount = core.money(link.foreignamount);
        totalBySource.set(String(source.id), (totalBySource.get(String(source.id)) || 0) + amount);
        return { id: `${link.invoice}-${link.payment}-${link.nextline}`, invoice: String(link.invoice), source: String(source.id),
          customer: String(source.entity), subsidiary: String(source.subsidiary), currency: String(source.currency),
          date: source.docdate, method: String(source.paymentmethod || ''), memo: memo(source), amount };
      });
      for (const [sourceId, amount] of totalBySource) {
        const source = data.docs.find(doc => String(doc.id) === sourceId);
        if (amount > core.money(source.foreigntotal)) { throw new Error(`SOURCE_APPLICATION_CAPACITY_EXCEEDED:${sourceId}`); }
      }
      return payments;
    }
    function attachRefunds(credits, docs) {
      for (const meta of docs.filter(doc => doc.type === 'CustRfnd')) {
        usage(250);
        const rec = record.load({ type: 'customerrefund', id: id(meta.id), isDynamic: false });
        for (let index = 0; index < rec.getLineCount({ sublistId: 'apply' }); index += 1) {
          if (!checked(lineValue(rec, 'apply', 'apply', index))) { continue; }
          const credit = credits.find(doc => doc.id === String(lineValue(rec, 'apply', 'doc', index)));
          if (!credit) { continue; }
          if (credit.customer !== String(meta.entity) || credit.currency !== String(meta.currency) || credit.subsidiary !== String(meta.subsidiary)) {
            throw new Error(`REFUND_SCOPE_MISMATCH:${meta.id}`);
          }
          credit.refunds.push({ id: String(meta.id), method: String(meta.paymentmethod || ''), memo: memo(meta),
            amount: core.money(lineValue(rec, 'apply', 'amount', index)), posted: checked(meta.posting) });
        }
      }
    }
    function snapshot(customer) {
      const data = basis(customer);
      const toLoad = data.docs.filter(meta => ['CustInvc', 'CustCred', 'CustRfnd', 'DepAppl'].includes(meta.type));
      if (toLoad.length > config.maxRecordsToLoad) { throw new Error('LARGE_CUSTOMER_REQUIRES_BATCH_REVIEW'); }
      if (runtime.isFeatureInEffect({ feature: 'SUITETAX' })) { throw new Error('SUITETAX_REQUIRES_LINE_TAX_ADAPTER'); }
      const documents = data.docs.filter(meta => ['CustInvc', 'CustCred'].includes(meta.type)).map(meta => ({ meta, doc: loadDocument(meta) }));
      const invoices = documents.filter(entry => entry.meta.type === 'CustInvc').map(entry => entry.doc);
      for (const invoice of invoices) {
        for (const line of invoice.lines) {
          const source = data.lineSources.find(s => String(s.invoice) === invoice.id && String(s.linekey) === line.line);
          line.so = source?.so ? id(source.so) : '';
        }
      }
      const credits = documents.filter(entry => entry.meta.type === 'CustCred').map(entry => creditDocument(entry.doc));
      for (const credit of credits) {
        credit.onAccount = data.applications.filter(link => link.paymenttype === 'CustCred' && String(link.payment) === credit.id)
          .reduce((total, link) => total + core.money(link.foreignamount), 0);
      }
      const payments = funding(data);
      attachRefunds(credits, data.docs);
      return { customer: id(customer), invoices, credits, payments, manual: data.current.manual,
        physical: data.balance, stamp: data.stamp, issues: [] };
    }
    function ensureWriter() {
      const account = String(runtime.accountId).split('_')[0];
      if (account !== config.account) { throw new Error('WRONG_NETSUITE_ACCOUNT'); }
      if (runtime.getCurrentScript().deploymentId !== config.writerDeployment) { throw new Error('USE_SINGLE_DESIGNATED_DEPLOYMENT'); }
    }
    function submit(type, internalId, values) {
      if (![config.allocationType, config.refundType].includes(type)) { throw new Error('FINANCIAL_WRITE_FORBIDDEN'); }
      record.submitFields({ type, id: id(internalId), values, options: { enableSourcing: false } });
    }
    function invalidate(customer) {
      const found = searchRows(config.allocationType, [[A.customer, 'anyof', id(customer)], 'and', [A.verified, 'is', 'T']], ['internalid']);
      for (const row of found) { submit(config.allocationType, row.internalid, { [A.verified]: false }); }
    }
    function upsert(type, key, values) {
      if (![config.allocationType, config.refundType].includes(type)) { throw new Error('FINANCIAL_WRITE_FORBIDDEN'); }
      usage(200);
      const found = searchRows(type, [['externalidstring', 'is', key]], ['internalid']);
      if (found.length > 1) { throw new Error(`DUPLICATE_LEDGER_KEY:${key}`); }
      const rec = found.length ? record.load({ type, id: id(found[0].internalid), isDynamic: false }) : record.create({ type, isDynamic: false });
      rec.setValue({ fieldId: 'externalid', value: key });
      for (const [name, value] of Object.entries(values)) { rec.setValue({ fieldId: name, value }); }
      return String(rec.save({ enableSourcing: false, ignoreMandatoryFields: false }));
    }
    function putAllocation(row, verified, issues = []) {
      const values = { name: `${issues.length ? `REVIEW ${issues[0]} | ` : ''}${row.key}`.slice(0, 290), isinactive: false };
      const data = { ...row, rate: row.rate / 100, verified };
      for (const [key, fieldId] of Object.entries(A)) { values[fieldId] = data[key]; }
      return upsert(config.allocationType, row.key, values);
    }
    function putEvent(row) {
      const values = { name: row.key.slice(0, 290), isinactive: false };
      const data = { ...row, amount: row.amount / 100 };
      for (const [key, fieldId] of Object.entries(R)) { values[fieldId] = data[key]; }
      return upsert(config.refundType, row.key, values);
    }
    function budget(current, result) {
      // Search/load/save plus publication, two source rechecks and an invalidation reserve.
      usage(500 + result.allocations.length * 22 + result.events.length * 20 +
        current.allocations.length * 4 + current.events.length * 4);
    }
    return { customers, existing, snapshot, ensureWriter, invalidate, putAllocation, putEvent, budget,
      version: customer => basis(customer).stamp,
      publish: row => submit(config.allocationType, row.id, { [A.verified]: true }),
      retireAllocation: row => submit(config.allocationType, row.id, { [A.verified]: false, isinactive: true }),
      reverseEvent: row => submit(config.refundType, row.id, { [R.status]: 'REVERSED' }) };
  });
