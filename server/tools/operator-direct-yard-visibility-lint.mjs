import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {ESLint} from '/test-toolchain/node_modules/eslint/lib/api.js';

const out='/app/test-artifacts/operator-direct-yard-visibility';
const prepared=JSON.parse(await readFile(`${out}/prepared.json`,'utf8'));
const source=await readFile('/app/src/delivery-repository.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),prepared.sourceHashes['src/delivery-repository.js']);
const helper=source.slice(source.indexOf('function completedLinkedYardWork('),source.indexOf('\nfunction groupLineKey('));
assert.ok(helper.startsWith('function completedLinkedYardWork('));
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{
  languageOptions:{ecmaVersion:'latest',sourceType:'module'},
  rules:{'no-undef':'error','no-unused-vars':'error','no-unreachable':'error','no-dupe-args':'error',
    'no-constant-condition':'error','valid-typeof':'error',complexity:['error',15]}
}]});
const results=await eslint.lintText('import {isDeliveryPickableLine,positiveQuantity,lineHasOpenQuantity,lineHasPackedQuantity} from "./delivery-helpers.js";\nexport '+helper,{filePath:'yard-work-filter.js'});
assert.ok(results.every(result=>result.errorCount===0 && result.warningCount===0));
await writeFile(`${out}/lint.json`,JSON.stringify({exit:0,sourceHashes:prepared.sourceHashes,
  scope:'Exact new completedLinkedYardWork function; whole release file syntax checked by the regression runner.',results},null,2)+'\n');
console.log(JSON.stringify({stage:'lint',exit:0}));
