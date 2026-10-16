import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { parse } from "espree";

const compiled = new Map();

// Execute actual production functions, retaining offsets for V8 coverage.
// Parsing supports multiline destructured parameters in the PO repository.
export function destinationFunctions(relativeFile, names, dependencies = {}) {
  const file = fileURLToPath(new URL(relativeFile, import.meta.url));
  const key = JSON.stringify([file, names, Object.keys(dependencies)]);
  if (!compiled.has(key)) {
    const source = readFileSync(file, "utf8");
    const parsed = parse(source, { ecmaVersion: "latest", sourceType: "module", range: true });
    let body = source.replace(/[^\n\r]/gu, " ");
    for (const name of names) {
      const declaration = parsed.body.find(statement => {
        const candidate = statement.declaration || statement;
        return candidate.type === "FunctionDeclaration" && candidate.id?.name === name;
      });
      assert.ok(declaration, `Missing production function ${name}`);
      const [start, end] = declaration.range;
      body = body.slice(0, start) + source.slice(start, end).replace(/^export /u, "       ") + body.slice(end);
    }
    compiled.set(key, compileFunction(`${body}\nreturn {${names.join(",")}};`, Object.keys(dependencies), { filename: file }));
  }
  return compiled.get(key)(...Object.values(dependencies));
}
