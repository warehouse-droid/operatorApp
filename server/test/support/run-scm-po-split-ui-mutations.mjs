// @ts-check

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const CLIENT = "public/dispatch-scm.js";
const PAGE = "public/dispatch-scm.html";
const STYLES = "public/dispatch.css";
const TEST = "test/dispatch/frontend/scm-po-split-ui.test.js";
/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string, occurrences?: number}>} */
const MUTANTS = Object.freeze([
  {
    name: "split Update action returns",
    target: CLIENT,
    from: '${isSplit ? `<button class="danger-button" data-action="unsplit-order" type="button" ${splitLocked ? "disabled" : ""}>${t("dispatch.unsplit", "Unsplit")}</button>` : ""}',
    to: '${isSplit ? `<button data-action="update-split" type="button">Update</button><button class="danger-button" data-action="unsplit-order" type="button" ${splitLocked ? "disabled" : ""}>${t("dispatch.unsplit", "Unsplit")}</button>` : ""}'
  },
  {
    name: "live destination selection is ignored",
    target: CLIENT,
    from: "const matched = SCM_DESTINATION_YARDS.find((yard) => yard.id === selected);",
    to: "const matched = null;"
  },
  {
    name: "live pickup selection is ignored",
    target: CLIENT,
    from: `const matched = scmVendorYardOptions(order).find((option) =>
    String(option.yard).trim().toLowerCase() === selected.toLowerCase()
  );`,
    to: "const matched = null;"
  },
  {
    name: "unknown destination bypasses the allowed-yard guard",
    target: CLIENT,
    from: "scmDestinationLocationId = matched?.id || fallback;",
    to: "scmDestinationLocationId = selected || fallback;"
  },
  {
    name: "selected initial status is discarded",
    target: CLIENT,
    from: "const status = scmLiveSplitInitialStatus();",
    to: 'const status = "Queued";'
  },
  {
    name: "entered split remark is discarded",
    target: CLIENT,
    from: "const remarkOverride = scmLiveSplitRemark();",
    to: 'const remarkOverride = "";'
  },
  {
    name: "the concise NetSuite destination label regresses",
    target: CLIENT,
    from: '${escapeHtml(effectiveDestination)} (NetSuite)',
    to: '${t("dispatch.useNetsuiteLineDestinations", "Use NetSuite line destinations")} (${escapeHtml(effectiveDestination)})'
  },
  {
    name: "the schedule mini-grid loses its routing row",
    target: CLIENT,
    from: "scm-mini-row scm-mini-routing-row",
    to: "scm-mini-routing-row-disabled"
  },
  {
    name: "the schedule mini-grid loses its notes row",
    target: CLIENT,
    from: "scm-mini-row scm-mini-notes-row",
    to: "scm-mini-notes-row-disabled"
  },
  {
    name: "schedule saves request an eventually stale full list",
    target: CLIENT,
    from: '${encodeURIComponent(order.id)}?includeSchedule=false`, {',
    to: '${encodeURIComponent(order.id)}`, { '
  },
  {
    name: "schedule and remark saves discard authoritative rows",
    target: CLIENT,
    occurrences: 2,
    from: "    if (!applyAuthoritativeScmScheduleRow(payload.row, order.id)) await loadScmOrders();",
    to: "    await loadScmOrders();"
  },
  {
    name: "a stale catalog card always overrides newer hydrated schedule detail",
    target: CLIENT,
    from: "  const detailIsAtLeastAsFresh = detailRevision.milliseconds > cardRevision.milliseconds",
    to: "  const detailIsAtLeastAsFresh = false && detailRevision.milliseconds > cardRevision.milliseconds"
  },
  {
    name: "schedule merge drops sub-millisecond revision precision",
    target: CLIENT,
    from: '      fractional: fractional.padEnd(9, "0").slice(0, 9)',
    to: '      fractional: "000000000"'
  },
  {
    name: "hydrated detail always overrides a newer targeted card refresh",
    target: CLIENT,
    from: "  const detailIsAtLeastAsFresh = detailRevision.milliseconds > cardRevision.milliseconds",
    to: "  const detailIsAtLeastAsFresh = true || detailRevision.milliseconds > cardRevision.milliseconds"
  },
  {
    name: "the physical destination response is not merged locally",
    target: CLIENT,
    from: "      applyAuthoritativeScmDestination(destinationPayload, order.id, destination);",
    to: "      void destinationPayload;"
  },
  {
    name: "the responsive routing layout selector is disconnected",
    target: STYLES,
    occurrences: 3,
    from: ".scm-mini-routing-row",
    to: ".scm-mini-routing-row-disabled"
  },
  {
    name: "the responsive notes layout selector is disconnected",
    target: STYLES,
    occurrences: 2,
    from: ".scm-mini-notes-row",
    to: ".scm-mini-notes-row-disabled"
  },
  {
    name: "the fixed client cache key is removed",
    target: PAGE,
    from: "dispatch-scm.js?v=20260831-live-schedule-v1",
    to: "dispatch-scm.js?v=stale-po-split-client"
  }
]);

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @type {Map<string, string>} */
const originals = new Map();
for (const file of [CLIENT, PAGE, STYLES, TEST]) {
  originals.set(file, await readFile(path.join(ROOT, file), "utf8"));
}

/** @param {string} file */
function originalFor(file) {
  const original = originals.get(file);
  if (original === undefined) {
    throw new Error(`Missing mutation source ${file}.`);
  }
  return original;
}

let killed = 0;
for (const mutant of MUTANTS) {
  const original = originalFor(mutant.target);
  const expectedOccurrences = mutant.occurrences || 1;
  if (occurrenceCount(original, mutant.from) !== expectedOccurrences) {
    throw new Error(`${mutant.name}: expected ${expectedOccurrences} mutation target occurrence(s).`);
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), "scm-po-split-ui-mutant-"));
  try {
    await mkdir(path.join(sandbox, "public"), { recursive: true });
    await mkdir(path.join(sandbox, "test/dispatch/frontend"), { recursive: true });
    await writeFile(path.join(sandbox, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(
      path.join(sandbox, CLIENT),
      mutant.target === CLIENT ? original.replaceAll(mutant.from, mutant.to) : originalFor(CLIENT),
      "utf8"
    );
    await writeFile(
      path.join(sandbox, PAGE),
      mutant.target === PAGE ? original.replaceAll(mutant.from, mutant.to) : originalFor(PAGE),
      "utf8"
    );
    await writeFile(
      path.join(sandbox, STYLES),
      mutant.target === STYLES ? original.replaceAll(mutant.from, mutant.to) : originalFor(STYLES),
      "utf8"
    );
    await writeFile(path.join(sandbox, TEST), originalFor(TEST), "utf8");
    const result = spawnSync(process.execPath, ["--test", TEST], {
      cwd: sandbox,
      encoding: "utf8"
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

console.log(`SCM PO split UI mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
