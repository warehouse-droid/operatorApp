import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(sourceDirectory, "..");
const operatorPath = path.join(serverRoot, "public/operator.js");
const testPath = path.join(serverRoot, "test/mbt/unit/sales-order-reload-photo-entry.test.js");
const matrixPath = path.join(serverRoot, "test/sales-order-reload-regression-matrix.md");
const original = await readFile(operatorPath, "utf8");

function replaceExact(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, `Mutation target count changed: ${from}`);
  return source.replace(from, to);
}

const mutations = [
  {
    name: "treat a preparing re-load as photo-ready",
    from: 'String(cycle.status || "") === "packed"',
    to: 'String(cycle.status || "") === "preparing"'
  },
  {
    name: "hide a packed re-load outside the canonical Packed view",
    from: 'show: reloadReady || mode === "packed",',
    to: 'show: mode === "packed",'
  },
  {
    name: "allow packed quantity edits after a re-load is packed",
    from: "allowPackedQuantityEdit: !reloadReady,",
    to: "allowPackedQuantityEdit: true,"
  },
  {
    name: "skip the fresh re-load status read before photo entry",
    from: 'const refreshed = await api(`/api/delivery/orders/${encodeURIComponent(order.netsuite_id)}`);',
    to: 'const refreshed = selectedOrder;'
  },
  {
    name: "leave the re-load camera closed after entering the load screen",
    from: "if (order.reload_authorized) await startFulfillmentCamera();",
    to: "if (false) await startFulfillmentCamera();"
  },
  {
    name: "allow re-load confirmation with one photo",
    from: "fulfillmentPhotoCount >= 2 && !fulfillmentSubmitting",
    to: "fulfillmentPhotoCount >= 1 && !fulfillmentSubmitting"
  }
];

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "reload-photo-mutations-"));
const temporaryOperator = path.join(temporaryRoot, "public/operator.js");
const temporaryTest = path.join(temporaryRoot, "test/mbt/unit/sales-order-reload-photo-entry.test.js");
try {
  await mkdir(path.dirname(temporaryOperator), { recursive: true });
  await mkdir(path.dirname(temporaryTest), { recursive: true });
  await copyFile(testPath, temporaryTest);
  await copyFile(matrixPath, path.join(temporaryRoot, "test/sales-order-reload-regression-matrix.md"));
  await copyFile(path.join(serverRoot, "package.json"), path.join(temporaryRoot, "package.json"));

  function runCandidate(source) {
    return writeFile(temporaryOperator, source).then(() => spawnSync(
      process.execPath,
      ["--test", temporaryTest],
      {
        cwd: temporaryRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 15_000
      }
    ));
  }

  const control = await runCandidate(original);
  assert.equal(control.error, undefined, control.error?.message);
  assert.equal(control.status, 0, `Unmutated re-load photo-entry test failed:\n${control.stdout}\n${control.stderr}`);

  let killed = 0;
  const survived = [];
  for (const mutation of mutations) {
    const result = await runCandidate(replaceExact(original, mutation.from, mutation.to));
    assert.equal(result.error, undefined, `${mutation.name}: ${result.error?.message}`);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0 && /not ok \d+ - /u.test(output)) {
      killed += 1;
    } else {
      survived.push(mutation.name);
    }
  }

  assert.equal(
    killed,
    mutations.length,
    `Every critical re-load photo-entry mutant must be killed. Survived: ${survived.join(", ")}`
  );
  console.log(`Re-load photo-entry mutation harness passed; ${killed}/${mutations.length} mutants killed.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
