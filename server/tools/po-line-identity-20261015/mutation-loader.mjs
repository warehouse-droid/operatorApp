import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && fileURLToPath(url) === process.env.PO_IDENTITY_MUTANT_TARGET) {
    return { format: "module", source: await readFile(process.env.PO_IDENTITY_MUTANT_SOURCE, "utf8"), shortCircuit: true };
  }
  return nextLoad(url, context);
}
