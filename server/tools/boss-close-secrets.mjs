import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';
const diff=await fs.readFile('/workspace/test-artifacts/boss-reject-close-20261003/task.diff','utf8');
const findings=scanUnifiedDiff(diff);process.stdout.write(JSON.stringify({findings},null,2)+'\n');assert.equal(findings.length,0);
