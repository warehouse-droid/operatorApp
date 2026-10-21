// Test-only redirect: exercise the exact recovery script against the candidate source.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve as resolvePath} from 'node:path';
export async function resolve(specifier,context,next) {
  if(specifier.startsWith('/app/src/')) {
    assert.equal(process.env.MBT_TEST_ISOLATED,'1');
    assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
    return next(pathToFileURL(resolvePath('src',specifier.slice('/app/src/'.length))).href,context);
  }
  return next(specifier,context);
}
