import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {ESLint} from 'eslint';
const mode=process.argv[2] || 'current';
const files=JSON.parse(readFileSync('tools/sor-rentals-files.json')).filter(file=>file.endsWith('.js')&&existsSync(file));
const engine=new ESLint({overrideConfigFile:'tools/sor-rentals-eslint.config.mjs',fix:mode==='fix'});
if(mode==='fix'){
 const fixed=await engine.lintFiles(files.filter(file=>file.includes('/sor-')));
 writeFileSync('test-artifacts/sor-rentals/lint-fixes.json',JSON.stringify(fixed.filter(row=>row.output).map(row=>({file:row.filePath.replace('/app/',''),output:row.output}))));
 process.exit(0);
}
const result=await engine.lintFiles(files);
writeFileSync(`test-artifacts/sor-rentals/lint-${mode}.json`,JSON.stringify(result.map(row=>({file:row.filePath.replace('/app/',''),messages:row.messages})),null,2));
console.log(JSON.stringify({mode,files:files.length,errors:result.reduce((n,row)=>n+row.errorCount,0),warnings:result.reduce((n,row)=>n+row.warningCount,0)}));
