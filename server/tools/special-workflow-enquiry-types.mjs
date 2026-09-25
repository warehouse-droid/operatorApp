import {mkdtemp,copyFile,writeFile,rm,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const root=await mkdtemp('/tmp/special-enquiry-types-');
try {
 await copyFile('src/special-stock-customer-directory.js',`${root}/special-stock-customer-directory.js`);
 await writeFile(`${root}/package.json`,'{"type":"module"}');
 // The unchanged shared DB implementation imports untyped legacy modules.
 // Check the exact new source against its pg query boundary; integration tests
 // execute the SQL against PostgreSQL rather than this declaration.
 await writeFile(`${root}/db.d.ts`,'export function query(sql:string,params?:unknown[]):Promise<{rowCount:number;rows:any[]}>;');
 await symlink('/app/node_modules',`${root}/node_modules`);
 const result=spawnSync('node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--strict','--skipLibCheck','--target','ES2022','--module','NodeNext',`${root}/special-stock-customer-directory.js`],{encoding:'utf8'});
 process.stdout.write(result.stdout+result.stderr);
 if(result.status!==0)process.exitCode=1;
 else console.log('Exact customer-directory source passed strict type checks against the SQL boundary declaration.');
}finally{await rm(root,{recursive:true,force:true});}
