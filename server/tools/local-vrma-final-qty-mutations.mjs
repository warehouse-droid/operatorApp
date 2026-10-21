import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "local-vrma-mutation-"));
const artifact = path.resolve("test-artifacts");
const file = "src/delivery-repository.js";
const original = fs.readFileSync(file, "utf8");
const cases = [
  ["estimate-instead-of-actual", "Math.min(estimatedQty, lineLoadedSalesQuantity(line) + packedQty)", "estimatedQty", "property:"],
  ["dry-run-writes", "if (!dryRun) await query(", "if (true) await query(", "historical local VRMA dry-run"],
  ["unproven-legacy-order", "if (!proofs.length) return;", "if (false) return;", "without load proof"],
  ["duplicate-load-record", "if (previous.rows[0]) return { ...previous.rows[0].response, id: previous.rows[0].id };", "if (false) return previous.rows[0];", "concurrent local VRMA"],
  ["overestimate-rounding", "isVrmaDeliveryOrder(order) ? 0.000001 : LOAD_SALES_QTY_TOLERANCE", "LOAD_SALES_QTY_TOLERANCE", "rounding tolerance"],
  ["other-order-balance-closed", 'const nextStatus = remainingLines.length ? "partial_loaded" : "loaded";', 'const nextStatus = "loaded";', "partial loading still"],
  ["packing-cap-removed", "packedSalesQty = Math.min(\n      availableSales,", "packedSalesQty = Math.max(\n      availableSales,", "packing alone"],
  ["unbounded-maintenance", "orderRefs.length > 500", "false", "explicit bounded list"],
  ["manual-pallet-count-lost", "? finalQty : consumed.pallet", "? 0 : consumed.pallet", "sales-only PLT"],
  ["premature-load", 'if (!["packed", "loaded"].includes(order.operator_status)) {\n    throw new Error("VRMA order must be packed before loading.");\n  }', "", "packing alone"]
];
const results = [];
try {
  for (const dir of ["src", "public", "test"]) { fs.cpSync(dir, path.join(scratch, dir), { recursive: true }); }
  fs.copyFileSync("package.json", path.join(scratch, "package.json"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(scratch, "node_modules"));
  for (const [name, from, to, pattern] of cases) {
    assert.equal(original.split(from).length, 2, `Mutation must have one target: ${name}`);
    fs.writeFileSync(path.join(scratch, file), original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, "test/mbt/integration/local-vrma-final-qty.test.js"],
      { cwd: scratch, env: process.env, encoding: "utf8", timeout: 60000 });
    fs.writeFileSync(path.join(artifact, `mutation-${name}.log`), `${result.stdout || ""}${result.stderr || ""}`);
    assert.equal(result.signal, null, `Mutation timed out: ${name}`);
    assert.ok(result.status !== 0 && /not ok/.test(result.stdout), `Surviving mutation: ${name}`);
    results.push({ name, killed: true });
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
assert.equal(fs.readFileSync(file, "utf8"), original);
fs.writeFileSync(path.join(artifact, "mutations.json"), JSON.stringify(results, null, 2));
console.log(`${results.length}/${cases.length} mutations killed; runtime source unchanged.`);
