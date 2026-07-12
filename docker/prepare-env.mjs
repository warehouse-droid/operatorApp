import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "server");
const targetDir = path.join(root, "docker", "env");
const force = process.argv.includes("--force");
const databaseUser = "mbbs_app";
const databaseName = "mbbs_yard";

async function existingDatabasePassword() {
  try {
    const source = await fs.readFile(path.join(targetDir, ".env"), "utf8");
    return source.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

function setValue(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

async function prepareFile(name, sharedPassword) {
  const sourcePath = path.join(sourceDir, name);
  const targetPath = path.join(targetDir, name);
  const source = await fs.readFile(sourcePath, "utf8");
  try {
    if (!force) {
      await fs.access(targetPath);
      console.log(`Kept existing ${path.relative(root, targetPath)}.`);
      return;
    }
  } catch {
    // Create the missing runtime environment file.
  }

  let output = source;
  output = setValue(output, "DATABASE_URL", `postgres://${databaseUser}:${sharedPassword}@db:5432/${databaseName}`);
  output = setValue(output, "POSTGRES_USER", databaseUser);
  output = setValue(output, "POSTGRES_PASSWORD", sharedPassword);
  output = setValue(output, "POSTGRES_DB", databaseName);
  output = setValue(output, "OLLAMA_BASE_URL", "http://ollama:11434");
  output = setValue(output, "OLLAMA_MODEL", "qwen3:4b-instruct");
  output = setValue(output, "MBBS_APP_HOST_PORT", "3001");
  await fs.writeFile(targetPath, output, { encoding: "utf8", mode: 0o600 });
  console.log(`Prepared ${path.relative(root, targetPath)}.`);
}

await fs.mkdir(targetDir, { recursive: true });
const password = await existingDatabasePassword() || crypto.randomBytes(24).toString("base64url");
await prepareFile(".env", password);
try {
  await prepareFile(".env.old", password);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await fs.copyFile(path.join(targetDir, ".env"), path.join(targetDir, ".env.old"));
  console.log("Prepared docker/env/.env.old from the active environment.");
}
