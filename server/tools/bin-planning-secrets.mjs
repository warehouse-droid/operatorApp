import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scanPaths } from "../test/support/scan-diff-secrets.mjs";
const files = JSON.parse(readFileSync("tools/bin-planning-files.json", "utf8"));
const findings = await scanPaths(files);
// Match the entire reviewed line; a changed value must be reviewed again.
const exceptions = [
  { file: "public/dispatch.js", sha256: "256022ee40191b3a73413be4199df8dc374c5b3b5e96622f0f7bdd9ba02ddaa5",
    reason: "Existing dynamic HTML attribute; no literal credential" },
  { file: "tools/bin-planning-test.sh", sha256: "159342197e16ee6fdf67676766478016ecfe45cc1b6e1c2590d2294e167cb244",
    reason: "Disposable internal test database credential" }
];
const reviewed = [];
const unexpected = findings.filter(finding => {
  const line = readFileSync(finding.file, "utf8").split("\n")[finding.line - 1];
  const sha256 = createHash("sha256").update(line).digest("hex");
  const exception = finding.kind === "credential_assignment"
    && exceptions.find(entry => entry.file === finding.file && entry.sha256 === sha256);
  if (exception) {
    reviewed.push({ ...finding, reason: exception.reason });
    return false;
  }
  return true;
});
console.log(JSON.stringify({ files: files.length, unexpected, reviewedFalsePositives: reviewed }, null, 2));
if (unexpected.length) {throw new Error("Unexpected secret-scan finding");}
