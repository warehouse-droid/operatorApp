import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertMbtCiWorkflow } from "./ci-workflow-contract.mjs";

const workflowPath = path.resolve(process.argv[2] || "../.github/workflows/mbt-p1.yml");
const phase = String(process.argv[3] || "P1");
const source = await readFile(workflowPath, "utf8");
assertMbtCiWorkflow(source, { phase });
console.log(`MBT ${phase} CI workflow safety checks passed: ${workflowPath}`);
