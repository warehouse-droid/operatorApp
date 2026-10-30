/**
 * Pallet payment policy. All amounts inside this module are integer cents.
 * @NApiVersion 2.1
 */
define([], () => {
  'use strict';
  const METHODS = { '1': 'CASH', '2': 'CHECK', '4': 'MASTER CARD', '5': 'VISA',
    '6': 'AMERICAN EXPRESS', '7': 'EFT', '8': 'DEBIT CARD', '9': 'EMT',
    '10': 'DIRECT DEPOSIT', '11': 'UNIONPAY', '13': 'WECHAT/ALIPAY' };
  const CARDS = ['4', '5', '6', '8', '11'];
  const REF = '(?:SO[A-Z]?\\d+|INV[A-Z]?\\d+|CM[A-Z]?\\d+|PYMT[A-Z]?\\d+|DEPOSIT)';
  const LABEL = '(?:VISA|MASTER ?CARD|MC|AMERICAN EXPRESS|AMEX|DEBIT(?: CARD)?|UNIONPAY|CARD)';
  const REF_TAIL = new RegExp(`^${REF}\\s*(?:\\(\\s*(\\d{4})\\s*\\)|[/+#、,]\\s*(\\d{4}))$`);
  const LABEL_TAIL = new RegExp(`^(?:${REF}\\s*[/+-]?\\s*)?${LABEL}\\s*(?:\\*{4}|X{4}|ENDING(?: IN)?|LAST ?4[: ]*|[:#-])?\\s*(\\d{4})$`);

  function integer(value, label, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) {
      throw new Error(`INVALID_${label}`);
    }
    return value;
  }

  function money(value) {
    if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
      throw new Error('INVALID_MONEY');
    }
    const parts = String(value).split('.');
    return integer(Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0')), 'MONEY');
  }

  function sum(values) {
    return values.reduce((total, value) => integer(total + integer(value, 'AMOUNT'), 'SUM'), 0);
  }

  function card(method, memo) {
    const id = String(method || '');
    const label = METHODS[id];
    const bad = { ok: false, last4: '', normalized: label || 'UNKNOWN', reason: 'CARD_REFERENCE_REVIEW' };
    if (!label) { return { ...bad, reason: 'UNKNOWN_PAYMENT_METHOD' }; }
    if (!CARDS.includes(id)) { return { ok: true, last4: '', normalized: label }; }
    const text = String(memo || '').normalize('NFKC').trim().toUpperCase();
    if (text.length > 1000) { return bad; }
    const match = REF_TAIL.exec(text) || LABEL_TAIL.exec(text);
    if (!match) { return bad; }
    const brands = { '4': /MASTER ?CARD|\bMC\b/, '5': /VISA/, '6': /AMEX|AMERICAN EXPRESS/,
      '8': /DEBIT/, '11': /UNIONPAY/ };
    const conflicts = Object.keys(brands).some(key => key !== id && brands[key].test(text));
    if (conflicts) { return { ...bad, reason: 'CARD_BRAND_CONFLICT' }; }
    const last4 = match.slice(1).find(Boolean);
    return { ok: true, last4, normalized: `${label} ****${last4}` };
  }

  function scope(left, right) {
    return ['customer', 'currency', 'subsidiary'].every(field => String(left[field]) === String(right[field]));
  }

  function ordered(left, right) {
    return String(left.date).localeCompare(String(right.date)) || Number(left.id) - Number(right.id);
  }

  function problem(state, code, reference = '') {
    const issue = `${code}${reference ? `:${reference}` : ''}`;
    if (!state.issues.includes(issue)) { state.issues.push(issue); }
  }

  function paymentGroups(invoice, payments) {
    const groups = new Map();
    const seen = new Set();
    for (const payment of payments.filter(p => p.invoice === invoice.id).sort(ordered)) {
      if (seen.has(payment.id)) { throw new Error(`DUPLICATE_APPLICATION:${payment.id}`); }
      seen.add(payment.id);
      integer(payment.amount, 'APPLIED_AMOUNT');
      if (!scope(invoice, payment)) { throw new Error(`PAYMENT_SCOPE:${payment.id}`); }
      if (payment.amount === 0) { continue; }
      const parsed = card(payment.method, payment.memo);
      const groupKey = `${payment.method}-${parsed.last4 || (parsed.ok ? 'NA' : payment.source)}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { key: groupKey, method: payment.method, last4: parsed.last4,
          date: payment.date, fundedDate: payment.date, id: payment.source, funds: 0, sources: [], parsed });
      }
      const group = groups.get(groupKey);
      if (payment.date > group.fundedDate) { group.fundedDate = payment.date; }
      group.funds = sum([group.funds, payment.amount]);
      if (!group.sources.includes(payment.source)) { group.sources.push(payment.source); }
    }
    return Array.from(groups.values()).sort((a, b) => Number(b.method === '1') - Number(a.method === '1') || ordered(a, b));
  }

  function allocateLine(invoice, line, groups, state) {
    let remaining = integer(line.qty, 'PALLET_QUANTITY', 1);
    integer(line.net, 'NET_RATE', 1);
    integer(line.gross, 'GROSS_RATE', line.net);
    for (const group of groups) {
      const rate = group.method === '1' ? line.net : line.gross;
      const qty = Math.min(remaining, Math.floor(group.funds / rate));
      if (qty === 0) { continue; }
      const key = ['PPA1', invoice.customer, invoice.subsidiary, invoice.currency, invoice.id, line.line, group.key].join('-');
      state.allocations.push({ key, customer: invoice.customer, subsidiary: invoice.subsidiary,
        currency: invoice.currency, invoice: invoice.id, so: line.so || invoice.so, line: line.line,
        date: group.fundedDate > invoice.date ? group.fundedDate : invoice.date,
        method: group.method, last4: group.last4, rate, qty, sources: group.sources.slice().sort(),
        pending: 0, refunded: 0, available: qty });
      if (!group.parsed.ok) { problem(state, group.parsed.reason, group.sources.join(',')); }
      group.funds -= qty * rate;
      remaining -= qty;
    }
    if (remaining > 0) { problem(state, 'UNFUNDED_PALLETS', `${invoice.id}/${line.line}/${remaining}`); }
  }

  function allocateInvoices(input, state) {
    const seen = new Set();
    for (const invoice of input.invoices.slice().sort(ordered)) {
      try {
        if (seen.has(invoice.id)) { throw new Error(`DUPLICATE_INVOICE:${invoice.id}`); }
        seen.add(invoice.id);
        if (invoice.customer !== input.customer) { throw new Error(`INVOICE_CUSTOMER:${invoice.id}`); }
        const groups = paymentGroups(invoice, input.payments);
        for (const line of invoice.lines) {
          if (!(line.so || invoice.so)) { problem(state, 'MISSING_SALES_ORDER', invoice.id); }
          allocateLine(invoice, line, groups, state);
        }
      } catch (error) { problem(state, error.message, invoice.id); }
    }
  }

  function consume(allocation, qty, status) {
    integer(qty, 'REFUND_QUANTITY', 1);
    if (qty > allocation.available) { throw new Error('INSUFFICIENT_ALLOCATED_PALLETS'); }
    if (status === 'PENDING') { allocation.pending += qty; }
    else { allocation.refunded += qty; }
    allocation.available -= qty;
  }

  function matching(allocation, credit, refund, parsed) {
    const rate = refund.method === '1' ? credit.net : credit.gross;
    return scope(allocation, credit) && allocation.method === refund.method &&
      allocation.last4 === parsed.last4 && allocation.rate === rate && allocation.date <= credit.date;
  }

  function validateManual(row, allocation, credit) {
    integer(row.qty, 'REFUND_QUANTITY', 1);
    integer(row.amount, 'REFUND_AMOUNT', 1);
    if (!row.returnRef || !['PENDING', 'COMPLETED', 'APPLIED'].includes(row.status)) { throw new Error('INVALID_REFUND_STATUS_OR_REFERENCE'); }
    if (row.amount !== integer(row.qty * allocation.rate, 'REFUND_AMOUNT')) { throw new Error('REFUND_AMOUNT_MISMATCH'); }
    if (credit && (!scope(allocation, credit) || allocation.date > credit.date)) { throw new Error('REFUND_CREDIT_SCOPE'); }
    if (row.status === 'COMPLETED' && (!credit || !row.refund)) { throw new Error('COMPLETED_REFUND_NEEDS_CREDIT_AND_REFUND'); }
  }

  function manualRefundEvidence(row, allocation, credit, state) {
    if (row.status === 'APPLIED') { applyOnAccount(row, allocation, credit, state); return; }
    if (!row.refund) { return; }
    if (!credit) { throw new Error('REFUND_NEEDS_CREDIT'); }
    const refund = credit.refunds.find(r => r.id === row.refund);
    if (!refund) { throw new Error('REFUND_NOT_APPLIED_TO_CREDIT'); }
    const parsed = card(refund.method, refund.memo);
    if (!parsed.ok || !matching(allocation, credit, refund, parsed)) { throw new Error('REFUND_METHOD_CARD_OR_RATE_MISMATCH'); }
    if (row.status === 'COMPLETED' && !refund.posted) { throw new Error('REFUND_NOT_POSTED'); }
    const key = `${credit.id}/${refund.id}`;
    const amount = sum([state.refundUsed.get(key) || 0, row.amount]);
    if (amount > refund.amount) { throw new Error('REFUND_APPLICATION_EXCEEDED'); }
    state.refundUsed.set(key, amount);
  }

  function applyOnAccount(row, allocation, credit, state) {
    if (!credit || row.refund) { throw new Error('APPLIED_REQUIRES_CREDIT_WITHOUT_REFUND'); }
    const expected = allocation.method === '1' ? credit.net : credit.gross;
    if (allocation.rate !== expected) { throw new Error('CREDIT_SETTLEMENT_RATE_REVIEW'); }
    const amount = sum([state.accountUsed.get(credit.id) || 0, row.amount]);
    if (amount > (credit.onAccount || 0)) { throw new Error('CREDIT_INVOICE_APPLICATION_EXCEEDED'); }
    state.accountUsed.set(credit.id, amount);
  }

  function applyManual(input, state) {
    const seen = new Set();
    for (const row of input.manual) {
      if (row.status === 'REVERSED') { continue; }
      try {
        const allocation = state.allocations.find(a => a.key === row.allocation);
        if (!allocation) { throw new Error('ORIGINAL_ALLOCATION_MISSING_OR_CHANGED'); }
        const credit = input.credits.find(c => c.id === row.credit);
        if (row.credit && !credit) { throw new Error('CREDIT_MISSING_OR_VOIDED'); }
        validateManual(row, allocation, credit);
        const key = `${row.returnRef}/${row.allocation}`;
        if (seen.has(key)) { throw new Error('DUPLICATE_RETURN_ALLOCATION'); }
        seen.add(key);
        manualRefundEvidence(row, allocation, credit, state);
        consume(allocation, row.qty, row.status);
        if (credit) {
          const used = (state.creditUsed.get(credit.id) || 0) + row.qty;
          if (used > credit.qty) { throw new Error('CREDIT_PALLET_QUANTITY_EXCEEDED'); }
          state.creditUsed.set(credit.id, used);
        }
      } catch (error) { problem(state, error.message, row.id); }
    }
  }

  function historicalFullCash(credit, refund, used, usedQty) {
    // The quantity comes from a fully settled pallet-only credit, not gross cash divided by net cost.
    return refund.method === '1' && refund.posted && used === 0 && usedQty === 0 &&
      credit.refunds.length === 1 && !credit.onAccount && credit.gross > credit.net &&
      refund.amount === integer(credit.qty * credit.gross, 'CREDIT_GROSS_AMOUNT', 1);
  }

  function refundUnits(amount, rate) {
    if (amount % rate !== 0) { throw new Error('REFUND_TAX_OR_PARTIAL_AMOUNT_REVIEW'); }
    return integer(amount / rate, 'REFUND_QUANTITY', 1);
  }

  function autoRefund(credit, refund, state) {
    const used = state.refundUsed.get(`${credit.id}/${refund.id}`) || 0;
    const usedQty = state.creditUsed.get(credit.id) || 0;
    const amount = integer(refund.amount - used, 'REFUND_REMAINDER');
    if (amount === 0) { return; }
    // Manual allocation is the authority for mixed-goods and partially settled credits.
    if (usedQty === credit.qty) { return; }
    if (credit.mixed) { throw new Error('MIXED_CREDIT_REQUIRES_MANUAL_ALLOCATION'); }
    const parsed = card(refund.method, refund.memo);
    if (!parsed.ok) { throw new Error(parsed.reason); }
    const rate = integer(refund.method === '1' ? credit.net : credit.gross, 'REFUND_RATE', 1);
    const historical = historicalFullCash(credit, refund, used, usedQty);
    const qty = historical ? credit.qty : refundUnits(amount, rate);
    if (qty + usedQty > credit.qty) { throw new Error('CREDIT_PALLET_QUANTITY_EXCEEDED'); }
    const candidates = state.allocations.filter(a => matching(a, credit, refund, parsed));
    if (sum(candidates.map(a => a.available)) < qty) { throw new Error('REFUND_SOURCE_CAPACITY_OR_CARD_REVIEW'); }
    state.creditUsed.set(credit.id, usedQty + qty);
    recordAutoEvents(credit, refund, state, candidates, qty, rate, historical);
  }

  function recordAutoEvents(credit, refund, state, candidates, quantity, rate, historical) {
    const status = refund.posted ? 'COMPLETED' : 'PENDING';
    let qty = quantity;
    for (const allocation of candidates) {
      const take = Math.min(qty, allocation.available);
      if (take === 0) { continue; }
      consume(allocation, take, status);
      state.events.push({ key: `PRA1-${credit.id}-${refund.id}-${allocation.key}`, allocation: allocation.key,
        credit: credit.id, refund: refund.id,
        returnRef: `AUTO-CM-${credit.id}${historical ? '-FULL-CREDIT-TAX-INCLUDED' : ''}`, qty: take, amount: take * rate, status });
      qty -= take;
    }
  }

  function pendingNeedsCompletion(input, credit, state) {
    return input.manual.some(row => {
      if (row.credit !== credit.id || row.status !== 'PENDING') { return false; }
      return credit.refunds.some(refund => refund.posted && (row.refund === refund.id ||
        (!row.refund && refund.amount > (state.refundUsed.get(`${credit.id}/${refund.id}`) || 0))));
    });
  }

  function applyCredits(input, state) {
    const seen = new Set();
    for (const credit of input.credits.slice().sort(ordered)) {
      if (seen.has(credit.id)) { problem(state, 'DUPLICATE_CREDIT', credit.id); continue; }
      seen.add(credit.id);
      if (pendingNeedsCompletion(input, credit, state)) {
        problem(state, 'PENDING_REFUND_REQUIRES_COMPLETION', credit.id);
      }
      const refundIds = new Set();
      for (const refund of credit.refunds) {
        if (refundIds.has(refund.id)) { problem(state, 'DUPLICATE_REFUND_APPLICATION', refund.id); continue; }
        refundIds.add(refund.id);
        try { autoRefund(credit, refund, state); }
        catch (error) { problem(state, error.message, `${credit.id}/${refund.id}`); }
      }
      if ((state.creditUsed.get(credit.id) || 0) !== credit.qty) {
        problem(state, 'CREDIT_NOT_FULLY_ALLOCATED', credit.id);
      }
    }
  }

  function build(input) {
    const state = { allocations: [], events: [], issues: (input.issues || []).slice(),
      creditUsed: new Map(), refundUsed: new Map(), accountUsed: new Map() };
    allocateInvoices(input, state);
    applyManual(input, state);
    applyCredits(input, state);
    const issued = sum(input.invoices.flatMap(i => i.lines.map(l => integer(l.qty, 'PALLET_QUANTITY', 1))));
    const credited = sum(input.credits.map(c => integer(c.qty, 'CREDIT_QUANTITY', 1)));
    if (issued - credited !== input.physical) { problem(state, 'PHYSICAL_BALANCE_MISMATCH', `${issued}-${credited}!=${input.physical}`); }
    return { allocations: state.allocations, events: state.events, issues: state.issues, verified: state.issues.length === 0,
      issued, credited, physical: input.physical };
  }
  return { money, card, build, methods: METHODS };
});
