import { ESLint } from 'eslint';
import { writeFileSync } from 'node:fs';
const scope=process.argv[2] || 'implementation';
const files=scope==='tests'?['test/mbt/**/delivery-request*.js']:['src/delivery-request*.js','public/delivery-request*.js'];
const eslint=new ESLint({fix:true,overrideConfigFile:'tools/delivery-request-eslint.config.mjs'});
const results=await eslint.lintFiles(files);
writeFileSync(`test-artifacts/delivery-requests/format-${scope}.json`,JSON.stringify(results.map(row=>({filePath:row.filePath,output:row.output,messages:row.messages})),null,2));
process.stdout.write(JSON.stringify(results.filter(row=>row.messages.length).map(row=>({filePath:row.filePath,messages:row.messages})),null,2));
