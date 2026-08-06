import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertIsolatedComposeConfig } from "./test-foundation.mjs";

const composePath = path.resolve(process.argv[2] || "../docker-compose.mbt-test.yml");
const source = await readFile(composePath, "utf8");
assertIsolatedComposeConfig(source);
console.log(`Isolated Compose safety checks passed: ${composePath}`);
