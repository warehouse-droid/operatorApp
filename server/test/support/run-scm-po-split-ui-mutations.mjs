// @ts-check

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const CLIENT = "public/dispatch-scm.js";
const PAGE = "public/dispatch-scm.html";
const TEST = "test/dispatch/frontend/scm-po-split-ui.test.js";
const MUTANTS = Object.freeze([
  {
    name: "split Update action returns",
    target: CLIENT,
    from: '${isSplit ? `<button class="danger-button" data-action="unsplit-order" type="button">${t("dispatch.unsplit", "Unsplit")}</button>` : ""}',
    to: '${isSplit ? `<button data-action="update-split" type="button">Update</button><button class="danger-button" data-action="unsplit-order" type="button">${t("dispatch.unsplit", "Unsplit")}</button>` : ""}'
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
    name: "the fixed client cache key is removed",
    target: PAGE,
    from: "dispatch-scm.js?v=20260813-po-split-status-v3",
    to: "dispatch-scm.js?v=stale-po-split-client"
  }
]);

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @type {Map<string, string>} */
const originals = new Map();
for (const file of [CLIENT, PAGE, TEST]) {
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
  if (occurrenceCount(original, mutant.from) !== 1) {
    throw new Error(`${mutant.name}: expected exactly one mutation target.`);
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), "scm-po-split-ui-mutant-"));
  try {
    await mkdir(path.join(sandbox, "public"), { recursive: true });
    await mkdir(path.join(sandbox, "test/dispatch/frontend"), { recursive: true });
    await writeFile(path.join(sandbox, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(
      path.join(sandbox, CLIENT),
      mutant.target === CLIENT ? original.replace(mutant.from, mutant.to) : originalFor(CLIENT),
      "utf8"
    );
    await writeFile(
      path.join(sandbox, PAGE),
      mutant.target === PAGE ? original.replace(mutant.from, mutant.to) : originalFor(PAGE),
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
