// Type-check the new pure policy exactly as shipped, without claiming that the
// pre-existing, untyped repository graph is statically checked.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const source = fs.readFileSync("src/scm-dependency-management-policy.js", "utf8");
const match = /export function completedTransferUnlinkAllowed\([\s\S]+?^\}$/mu.exec(source);
assert.ok(match);
const directory = fs.mkdtempSync("/tmp/transfer-unlink-types-");
fs.writeFileSync(`${directory}/policy.js`, match[0]);
const result = spawnSync("node_modules/.bin/tsc", ["--noEmit", "--allowJs", "--checkJs", "--skipLibCheck", "--target", "ES2023", `${directory}/policy.js`], { encoding: "utf8" });
assert.equal(result.status, 0, result.stdout + result.stderr);
console.log("New completedTransferUnlinkAllowed policy: 0 type errors; legacy graph checked by syntax/tests.");
