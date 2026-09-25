export const mutants = {
  countFailedReceipts: { file: "src/receiving-receipt-progress.js", from: "AND receipt_status IN ('partial_received','received')", to: "AND true" },
  doubleCountSyncedReceipts: { file: "src/receiving-receipt-progress.js", from: "Math.max(positive(line.netsuite_received_qty), positive(line.netsuite_received_baseline_qty) + received)", to: "positive(line.netsuite_received_qty) + positive(line.netsuite_received_baseline_qty) + received" },
  retainUsedConfirmation: { file: "src/receiving-receipt-progress.js", from: "if (receipt && (!line.confirmed_at", to: "if (false && receipt && (!line.confirmed_at" },
  ignoreVerifiedParentProgress: { file: "src/operator-netsuite-posting-targets.js", from: "availableLines: storedOperatorPostingLines(sourceRows)", to: "availableLines: storedOperatorPostingLines(rows.rows || [])" },
  duplicateReceiptEvidence: { file: "src/receiving-receipt-progress.js", from: "if (seen.has(identity)) {continue;}", to: "if (false) {continue;}" },
  loseSequentialParentProgress: { file: "src/receiving-receipt-progress.js", from: "Math.max(previous, baseline) + positive(posted.quantity)", to: "baseline + positive(posted.quantity)" }
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutants[process.env.RECEIVING_FOLLOWUP_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation.file}`)) {return result;}
  const source = String(result.source);
  if (source.split(mutation.from).length !== 2) {throw new Error("Invalid mutation anchor");}
  return { ...result, source: source.replace(mutation.from, mutation.to) };
}
