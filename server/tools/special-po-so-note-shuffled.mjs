import assert from 'node:assert/strict';
import {run} from 'node:test';
import {tap} from 'node:test/reporters';
import {own} from './special-po-so-note-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const files=[...own];let seed=2026100117;
for(let i=files.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[files[i],files[j]]=[files[j],files[i]];}
console.log('# requested file order '+JSON.stringify(files));
// Node's CLI discovers and sorts files. The runner API accepts the explicit
// permutation, so this exercises a different sequence against the same DB.
const tests=run({files,concurrency:1});
tests.on('test:fail',()=>{process.exitCode=1;});
tests.compose(tap).pipe(process.stdout);
