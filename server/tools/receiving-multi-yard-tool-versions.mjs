import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const result = {
  node: process.version,
  tools: Object.fromEntries(['c8', 'eslint', 'typescript', 'fast-check', 'playwright']
    .map(name => [name, require(name + '/package.json').version])),
  image: 'mbbs-regular-v2:e2e',
  imageId: process.env.RECEIVING_MULTIYARD_TOOL_IMAGE_ID || null,
  databaseImage: 'postgres:18-alpine',
  databaseImageId: process.env.RECEIVING_MULTIYARD_DATABASE_IMAGE_ID || null
};
writeFileSync('test-artifacts/receiving-multi-yard/tool-versions.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
