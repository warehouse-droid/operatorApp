import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([".git", "data", "node_modules", "test-artifacts"]);
const PROVIDER_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/;
const QUOTED_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_-]*(?:password|secret|token|credential|private[_-]?key|api[_-]?key|database[_-]?url)[A-Za-z0-9_-]*\s*(?::|=)\s*(["'])([^"']*)\1/i;
const UNQUOTED_CONFIG_PATTERN = /^\s*(?:[A-Z0-9_-]*(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY|API_KEY|DATABASE_URL)[A-Z0-9_-]*)\s*(?::|=)\s*([^\s#;,]+)\s*$/i;
const PLACEHOLDER_PATTERN = /^(?:mbt[_-]?test|test|dummy|fake|example|invalid|placeholder|configured-secret-test|not-a-login|phase-one|must-not|do-not|rollback|harness)/i;

/** @param {string} value @param {string} filePath */
function isIsolatedTestPlaceholder(value, filePath) {
  const isolatedTestFixture = /(?:^|\/)test(?:\/|$)/u.test(filePath.replaceAll("\\", "/"));
  return isolatedTestFixture && (
    value.length === 1
    || /^(?:p[123]-|synthetic-|upload-token$|phase-(?:one|two|three)-)/iu.test(value)
  );
}

/** @param {string} value @param {string} filePath */
function isExplicitPlaceholder(value, filePath) {
  const raw = String(value || "").trim();
  const normalized = ((raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'")))
    ? raw.slice(1, -1)
    : raw;
  return normalized.length === 0
    || normalized === "[REDACTED]"
    || PLACEHOLDER_PATTERN.test(normalized)
    || /(?:test|fixture|placeholder)$/i.test(normalized)
    || isIsolatedTestPlaceholder(normalized, String(filePath || ""));
}

/**
 * @param {string} line
 * @param {string} filePath
 * @param {number} lineNumber
 * @returns {{file: string, line: number, kind: string} | null}
 */
function scanLineForSecret(line, filePath, lineNumber) {
  if (/secret-scan:\s*allow\b/i.test(line)) {
    return null;
  }
  if (PRIVATE_KEY_PATTERN.test(line)) {
    return { file: filePath, line: lineNumber, kind: "private_key" };
  }
  if (PROVIDER_TOKEN_PATTERN.test(line)) {
    return { file: filePath, line: lineNumber, kind: "provider_token" };
  }
  const quoted = QUOTED_ASSIGNMENT_PATTERN.exec(line);
  const isConfigFile = /(?:^|\/)(?:[^/]+\.(?:env|ya?ml|conf)|Dockerfile[^/]*)$/i.test(filePath);
  const unquoted = isConfigFile ? UNQUOTED_CONFIG_PATTERN.exec(line) : null;
  const candidate = quoted?.[2] ?? unquoted?.[1] ?? "";
  return (quoted || unquoted) && !isExplicitPlaceholder(candidate, filePath)
    ? { file: filePath, line: lineNumber, kind: "credential_assignment" }
    : null;
}

/**
 * Findings intentionally contain no matched credential value.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {{file: string, line: number, kind: string}[]}
 */
export function scanTextForSecrets(source, filePath) {
  const findings = [];
  const lines = String(source).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const finding = scanLineForSecret(line, filePath, index + 1);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * Scan only added lines from a zero-context unified Git diff.
 *
 * @param {string} source
 * @returns {{file: string, line: number, kind: string}[]}
 */
export function scanUnifiedDiff(source) {
  const findings = [];
  let currentFile = "";
  let nextLine = 0;
  for (const line of String(source).split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentFile = target.startsWith("b/") ? target.slice(2) : target;
      continue;
    }
    const hunk = /^@@ -[^+]*\+(\d+)/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = scanTextForSecrets(line.slice(1), currentFile);
      findings.push(...added.map((finding) => ({ ...finding, line: nextLine })));
      nextLine += 1;
      continue;
    }
    if (!line.startsWith("-")) {
      nextLine += 1;
    }
  }
  return findings;
}

/** @param {string} target @returns {Promise<string[]>} */
async function regularFiles(target) {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`Secret scan refuses symbolic links: ${target}`);
  }
  if (stat.isFile()) {
    return stat.size <= MAX_TEXT_BYTES ? [target] : [];
  }
  if (!stat.isDirectory() || IGNORED_DIRECTORIES.has(path.basename(target))) {
    return [];
  }
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
    .map((entry) => regularFiles(path.join(target, entry.name))));
  return nested.flat();
}

/** @param {string[]} requestedPaths @param {string} root */
export async function scanPaths(requestedPaths, root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  for (const requested of requestedPaths) {
    const target = path.resolve(resolvedRoot, requested);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Secret scan path escapes the repository: ${requested}`);
    }
    files.push(...await regularFiles(target));
  }

  const findings = [];
  for (const file of [...new Set(files)].sort()) {
    const buffer = await readFile(file);
    if (buffer.includes(0)) {
      continue;
    }
    const relative = path.relative(resolvedRoot, file);
    findings.push(...scanTextForSecrets(buffer.toString("utf8"), relative));
  }
  return findings;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const diffIndex = argumentsList.indexOf("--unified-diff");
  let diffPath = "";
  if (diffIndex >= 0) {
    diffPath = argumentsList[diffIndex + 1] || "";
    argumentsList.splice(diffIndex, 2);
  }
  if (argumentsList.length === 0 && !diffPath) {
    throw new Error("Provide one or more repository-relative paths to scan.");
  }
  const findings = await scanPaths(argumentsList);
  if (diffPath) {
    const resolvedDiff = path.resolve(process.cwd(), diffPath);
    const diffSource = await readFile(resolvedDiff, "utf8");
    findings.push(...scanUnifiedDiff(diffSource));
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: possible ${finding.kind} [value redacted]`);
    }
    throw new Error(`Secret scan found ${findings.length} high-confidence finding(s).`);
  }
  console.log(`Secret scan passed: ${argumentsList.length} new path(s), changed-line diff checked, no high-confidence findings.`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
