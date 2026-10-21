import { readdirSync } from "node:fs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const mode = process.argv[2] || "feature";
const files = [];
if (mode === "selected") {files.push(...process.argv.slice(3));}
if (mode === "dispatch") {
  const selected = /^dispatch-(plan|v2|edit-lease|.*timing|.*driver|.*load|.*forecast|.*prefix|save|executed|retired-confirm|completion)/u;
  for (const directory of ["unit", "integration", "concurrency", "property", "frontend"]) {
    for (const file of readdirSync(`test/dispatch/${directory}`)) {
      if (selected.test(file) && file.endsWith(".test.js") && file !== "dispatch-retired-confirm-repair.test.js") {files.push(`test/dispatch/${directory}/${file}`);}
    }
  }
}
if (!["dispatch", "selected"].includes(mode)) {
for (const directory of ["unit", "integration", "concurrency", "property"]) {
  for (const file of readdirSync(`test/mbt/${directory}`)) {
    const selected = mode === "baseline"
      ? /^(bin-dispatch|bin-contract|bin-leg|dispatch-bin|driver-bin|frontdesk-bin|frontdesk-multibin)/u.test(file)
      : file.startsWith("bin-planning-");
    if (selected && file.endsWith(".test.js")) {files.push(`test/mbt/${directory}/${file}`);}
  }
}
}
if (!files.length) {throw new Error("No BIN planning tests selected");}
if (process.env.BIN_PLANNING_REVERSE === "1" || process.argv[3] === "reverse") {files.reverse();}
process.exitCode = await runNodeTestFilesIsolated(files, { environment: process.env, label: `bin-planning-${mode}` });
