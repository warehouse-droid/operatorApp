// @ts-check

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const DOMAIN = "src/scm-schedule-remark.js";
const UNIT = "test/mbt/unit/scm-schedule-remarks.red.test.js";
const PROPERTY = "test/mbt/property/scm-schedule-remarks.property.test.js";
const MUTANTS = Object.freeze([
  {
    name: "local override no longer wins",
    from: "if (local) {",
    to: "if (false && local) {"
  },
  {
    name: "PO inherits NetSuite Memo instead of TO",
    from: 'trim().toUpperCase() === "TO" && memo',
    to: 'trim().toUpperCase() === "PO" && memo'
  },
  {
    name: "remark limit accepts 2,001 characters",
    from: "const SCM_SCHEDULE_REMARK_MAX_LENGTH = 2000;",
    to: "const SCM_SCHEDULE_REMARK_MAX_LENGTH = 2001;"
  },
  {
    name: "mixed operational patch is treated as remark-only",
    from: "return keys.every((key) => REMARK_PATCH_KEYS.has(key) || REMARK_PATCH_METADATA_KEYS.has(key));",
    to: "return true;"
  }
]);

const [domain, unit, property] = await Promise.all([
  readFile(path.join(ROOT, DOMAIN), "utf8"),
  readFile(path.join(ROOT, UNIT), "utf8"),
  readFile(path.join(ROOT, PROPERTY), "utf8")
]);

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

let killed = 0;
for (const mutant of MUTANTS) {
  if (occurrences(domain, mutant.from) !== 1) {
    throw new Error(`${mutant.name}: expected exactly one mutation target.`);
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), "scm-schedule-remark-mutant-"));
  try {
    await Promise.all([
      mkdir(path.join(sandbox, "src"), { recursive: true }),
      mkdir(path.join(sandbox, "test/mbt/unit"), { recursive: true }),
      mkdir(path.join(sandbox, "test/mbt/property"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(sandbox, "package.json"), '{"type":"module"}\n', "utf8"),
      writeFile(path.join(sandbox, DOMAIN), domain.replace(mutant.from, mutant.to), "utf8"),
      writeFile(path.join(sandbox, UNIT), unit, "utf8"),
      writeFile(path.join(sandbox, PROPERTY), property, "utf8")
    ]);
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", UNIT, PROPERTY], {
      cwd: sandbox,
      encoding: "utf8"
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      throw new Error(`${mutant.name}: survived.\n${result.stdout}\n${result.stderr}`);
    }
    killed += 1;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

console.log(`SCM schedule remark mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
