import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const client = await readFile("public/scm-schedule.js", "utf8");
const css = await readFile("public/dispatch.css", "utf8");
const directory = await mkdtemp(path.join(os.tmpdir(), "schedule-column-mutants-"));
const cases = [
  {
    label: "visibility must override existing cell display rules",
    env: "SCHEDULE_TEST_CSS", source: css,
    from: ".scm-sheet-row > .scm-sheet-cell[hidden] {\n  display: none !important;",
    to: ".scm-sheet-row > .scm-sheet-cell[hidden] {\n  display: none;",
    failingTest: "Show all and Reset layout restore columns without discarding drafts"
  },
  {
    label: "column choices must persist",
    env: "SCHEDULE_TEST_CLIENT", source: client,
    from: "localStorage.setItem(scmScheduleColumnPreferenceKey(), JSON.stringify({ hiddenColumns: [...scmScheduleHiddenColumns] }));",
    to: "void scmScheduleHiddenColumns;",
    failingTest: "column choices persist on reload and remain separate for another user and surface"
  },
  {
    label: "changing visibility must preserve draft editors",
    env: "SCHEDULE_TEST_CLIENT", source: client,
    from: "saveScmScheduleColumnPreferences();\n    applyScmScheduleColumnVisibility();",
    to: "saveScmScheduleColumnPreferences();\n    renderScmSchedule();",
    failingTest: "visibility changes preserve unsaved edits, selection and filters; saving retains hidden columns"
  }
];

try {
  for (const [index, candidate] of cases.entries()) {
    assert.ok(candidate.source.includes(candidate.from), `Mutation anchor missing: ${candidate.label}`);
    const filename = path.join(directory, `${index}.${candidate.env.endsWith("CSS") ? "css" : "js"}`);
    await writeFile(filename, candidate.source.replace(candidate.from, candidate.to));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/dispatch/frontend/scm-schedule-columns.browser.test.mjs"], {
      env: { ...process.env, [candidate.env]: filename, SCHEDULE_SCREENSHOT_DIR: "" },
      encoding: "utf8", timeout: 60000
    });
    assert.equal(result.status, 1, `Mutation did not fail cleanly: ${candidate.label}\n${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(candidate.failingTest)),
      `The intended behavioral test did not kill ${candidate.label}\n${result.stdout}`);
    console.log(`Killed ${index + 1}/${cases.length}: ${candidate.label}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
