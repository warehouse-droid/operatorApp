// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const TARGET = path.resolve("public/mbt-assets.js");
const FROM = "if (applyButton) applyButton.disabled = !state.csvPreview || !reason || state.csvBusy;";
const TO = "if (applyButton) applyButton.disabled = false;";

/** @param {string | Buffer} value */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, stdio?: import("node:child_process").SpawnOptions["stdio"]}} [options]
 */
function child(command, args, options = {}) {
  return spawn(command, args, {
    env: { ...process.env, ...options.env },
    stdio: options.stdio || "ignore"
  });
}

/** @param {import("node:child_process").ChildProcess} childProcess */
function completed(childProcess) {
  return new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`P3.5a UI mutation process exited on ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/** @param {string} url */
async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The isolated server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The isolated mutated UI server did not become healthy.");
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("P3.5a UI mutation requires the writable disposable MBT browser container.");
}

const original = await readFile(TARGET, "utf8");
const originalHash = hash(original);
if (original.split(FROM).length - 1 !== 1) {
  throw new Error("The P3.5a UI mutation target must occur exactly once.");
}

/** @type {import("node:child_process").ChildProcess | undefined} */
let server;
try {
  await writeFile(TARGET, original.replace(FROM, TO), "utf8");
  server = child(process.execPath, ["src/server.js"]);
  await waitForServer("http://127.0.0.1:3000/health");
  const test = child("npx", [
    "playwright",
    "test",
    "--config",
    "test/playwright.config.mjs",
    "test/mbt/e2e/p3-asset-csv-import.spec.js",
    "--project=chromium-desktop",
    "--grep",
    "download, raw preview"
  ], {
    env: { MBT_TEST_BASE_URL: "http://127.0.0.1:3000" }
  });
  if (await completed(test) === 0) {
    throw new Error("P3.5a Apply-without-reason UI mutant survived.");
  }
  console.log("P3.5a UI mutation score: 1/1 killed (100%).");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await completed(server).catch(() => undefined);
  }
  await writeFile(TARGET, original, "utf8");
  if (hash(await readFile(TARGET)) !== originalHash) {
    throw new Error("P3.5a UI mutation source restoration failed.");
  }
}
