// @ts-check

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(supportDirectory, "../..");

export const LEGACY_PUBLIC_FILES = Object.freeze([
  "public/login.js",
  "public/control.js",
  "public/app-sidebar.js",
  "public/dispatch-setup.js",
  "public/dispatch.js",
  "public/driver-offline-photos.js",
  "public/driver-offline-sync.js",
  "public/driver-service-worker.js",
  "public/driver.js",
  "public/driver-bin-ui.js",
  "public/i18n.js",
  "public/mbt-assets.js",
  "public/mbt-billing.js",
  "public/mbt-frontdesk.js",
  "public/mbt-gates.js",
  "public/mbt-home.js",
  "public/mbt-shell.js"
]);

/**
 * Ask the active Node runtime to parse each legacy browser script without
 * executing it.
 *
 * @param {readonly string[]} files
 * @returns {string[]}
 */
export function checkJavaScriptSyntax(files) {
  for (const file of files) {
    const absolutePath = path.isAbsolute(file) ? file : path.join(serverRoot, file);
    const result = spawnSync(process.execPath, ["--check", absolutePath], {
      encoding: "utf8"
    });

    if (result.error) {
      throw new Error(`JavaScript syntax check failed for ${file}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
      throw new Error(`JavaScript syntax check failed for ${file}:\n${detail}`);
    }
  }

  return [...files];
}

export function checkLegacyPublicSyntax() {
  return checkJavaScriptSyntax(LEGACY_PUBLIC_FILES);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const checkedFiles = checkLegacyPublicSyntax();
    console.log(`JavaScript syntax OK: ${checkedFiles.join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
