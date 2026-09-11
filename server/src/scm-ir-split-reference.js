const EPSILON = 0.000001;
const SPLIT_REFERENCE_PATTERN = /\bSN\s*[-#:]?\s*\d+\b/giu;

function text(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function quantity(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.max(Number(parsed.toFixed(6)), 0) : 0;
}

function canonicalSplitReference(value) {
  const match = text(value).match(SPLIT_REFERENCE_PATTERN)?.[0] || "";
  return match ? match.replace(/[-#: \t]/gu, "").toUpperCase() : "";
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function memoContainsAlias(memo, alias) {
  const normalizedMemo = text(memo).toUpperCase();
  const normalizedAlias = text(alias).toUpperCase();
  if (!normalizedMemo || !normalizedAlias) return false;
  const pattern = new RegExp(
    `(?:^|[^A-Z0-9])${escapedPattern(normalizedAlias)}(?=$|[^A-Z0-9])`,
    "u"
  );
  return pattern.test(normalizedMemo);
}

function targetAliases(target = {}) {
  const aliases = target.isParent === true || target.targetKind === "source_residual"
    ? (Array.isArray(target.receiptReferenceAliases) ? target.receiptReferenceAliases : [])
    : [
      target.targetOrderRef,
      ...(Array.isArray(target.targetOrderRefAliases) ? target.targetOrderRefAliases : [])
    ];
  return [...new Set(aliases.map(text).filter(Boolean))];
}

function targetMatchesMemo(target, memo, references) {
  return targetAliases(target).some((alias) => {
    const canonical = canonicalSplitReference(alias);
    return canonical
      ? references.includes(canonical)
      : memoContainsAlias(memo, alias);
  });
}

function receiptMemo(row = {}) {
  return text(
    row.transactionMemo
      ?? row.transaction_memo
      ?? row.snapshot?.transactionMemo
      ?? row.snapshot?.transaction_memo
      ?? row.snapshot?.raw?.transaction_memo
  );
}

export function extractScmSplitReferences(value = "") {
  return [...new Set([...text(value).matchAll(SPLIT_REFERENCE_PATTERN)]
    .map((match) => canonicalSplitReference(match[0]))
    .filter(Boolean))];
}

export function resolveScmReceiptSplitReference({
  transactionMemo = "",
  targets = []
} = {}) {
  const memo = text(transactionMemo);
  const references = extractScmSplitReferences(memo);
  const matches = (Array.isArray(targets) ? targets : [])
    .map((target, targetIndex) => ({ target, targetIndex }))
    .filter(({ target }) => targetMatchesMemo(target, memo, references));
  if (references.length > 1 || matches.length > 1) {
    return { status: "ambiguous", references, targetIndexes: matches.map((row) => row.targetIndex) };
  }
  if (matches.length === 1) {
    const [{ target, targetIndex }] = matches;
    return {
      status: "matched",
      reference: references[0] || text(target.targetOrderRef).toUpperCase(),
      targetIndex,
      targetOrderRef: target.targetOrderRef
    };
  }
  if (references.length === 1) return { status: "unmatched", reference: references[0] };
  return { status: "absent" };
}

function referenceIssue(row, resolution, reason) {
  return {
    transactionId: row?.netsuite_transaction_id ?? row?.transactionId ?? null,
    transactionRef: text(row?.transaction_ref ?? row?.transactionRef),
    transactionMemo: receiptMemo(row),
    reference: resolution.reference || (resolution.references || []).join(", "),
    status: resolution.status,
    reason
  };
}

export function allocateScmReceiptRowsBySplitReference({
  totalReceivedQty = 0,
  targets = [],
  receiptRows = []
} = {}) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const allocations = normalizedTargets.map(() => 0);
  const remainingReceiptRows = [];
  const unexplainedReferences = [];
  let remainingTotalQty = quantity(totalReceivedQty);
  let referenceOverflowQty = 0;
  let referencedRowCount = 0;

  for (const row of Array.isArray(receiptRows) ? receiptRows : []) {
    const rowQuantity = quantity(row?.quantity);
    const memo = receiptMemo(row);
    const resolution = resolveScmReceiptSplitReference({
      transactionMemo: memo,
      targets: normalizedTargets
    });
    if (resolution.status === "absent") {
      remainingReceiptRows.push(row);
      continue;
    }
    const budget = quantity(Math.min(rowQuantity, remainingTotalQty));
    remainingTotalQty = quantity(remainingTotalQty - budget);
    if (budget <= EPSILON) continue;
    referencedRowCount += 1;
    if (resolution.status !== "matched") {
      referenceOverflowQty = quantity(referenceOverflowQty + budget);
      unexplainedReferences.push(referenceIssue(
        row,
        resolution,
        resolution.status === "ambiguous"
          ? "The IR memo contains an ambiguous split-child reference."
          : "The IR memo reference does not identify an active split child for this source line."
      ));
      continue;
    }
    const target = normalizedTargets[resolution.targetIndex] || {};
    const capacity = quantity(quantity(target.requestedQty) - allocations[resolution.targetIndex]);
    const applied = quantity(Math.min(budget, capacity));
    allocations[resolution.targetIndex] = quantity(
      allocations[resolution.targetIndex] + applied
    );
    const overflow = quantity(budget - applied);
    if (overflow <= EPSILON) continue;
    referenceOverflowQty = quantity(referenceOverflowQty + overflow);
    unexplainedReferences.push(referenceIssue(
      row,
      resolution,
      "The referenced IR quantity exceeds the split child's source-line capacity."
    ));
  }

  return {
    allocations,
    remainingTotalQty,
    remainingReceiptRows,
    referenceOverflowQty,
    referencedRowCount,
    unexplainedReferences
  };
}
