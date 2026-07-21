import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb } from "./db.js";
import { activateSmartScmInputFile, listSmartScmInputFiles, storeSmartScmInputFile } from "./smart-scm-import-repository.js";

const SEED_FILES = Object.freeze([
  { slot: "item_master", filename: "InterlockItemMaster2026_20260713.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { slot: "sales_data", filename: "SalesData_20260713.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { slot: "decision_workbook", filename: "TO_PO Decision Tools_20260713.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { slot: "decision_tree", filename: "PO_TO Decision Tree Setup.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { slot: "decision_script", filename: "TOPO_DecisionTool.js", contentType: "text/javascript" }
]);

function seedRoot() {
  return process.env.SMART_SCM_SEED_ROOT || "/home/ubuntu";
}

export async function seedSmartScmInputs({ root = seedRoot(), operatorId = null } = {}) {
  const existing = await listSmartScmInputFiles();
  const results = [];
  for (const definition of SEED_FILES) {
    const sourcePath = path.join(root, definition.filename);
    const buffer = await fs.readFile(sourcePath);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    let file = existing.find((candidate) => candidate.slot === definition.slot && candidate.sha256 === sha256);
    let action = "reused";
    if (!file) {
      file = await storeSmartScmInputFile({
        slot: definition.slot,
        filename: definition.filename,
        contentType: definition.contentType,
        buffer,
        operatorId
      });
      action = "uploaded";
    }
    if (file.status !== "ready" && !file.active) {
      results.push({ slot: definition.slot, fileId: file.id, action, status: file.status, validation: file.validation });
      continue;
    }
    if (!file.active) {
      file = await activateSmartScmInputFile(file.id, operatorId);
      action = `${action}+activated`;
    }
    results.push({ slot: definition.slot, fileId: file.id, version: file.version, action, status: file.status, active: file.active, summary: file.importedSummary });
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const results = await seedSmartScmInputs();
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}
