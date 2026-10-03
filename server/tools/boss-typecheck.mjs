import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const root=process.cwd();
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'boss-types-'));
try {
 await fs.mkdir(path.join(directory,'src'));
 for(const file of (await fs.readdir('src')).filter(name=>name.startsWith('boss-approval-')||name==='account-email.js')){
  await fs.copyFile(path.join(root,'src',file),path.join(directory,'src',file));
 }
 await fs.symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'));
 await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module'}));
 // The existing database module is a boundary. Check new JavaScript against its
 // actual async query/transaction signatures without checking the whole legacy app.
 await fs.writeFile(path.join(directory,'src/db.d.ts'),`export function query(sql:string,params?:any[]):Promise<{rows:any[];rowCount:number}>;\nexport function withTransaction<T>(fn:()=>Promise<T>):Promise<T>;\n`);
 await fs.writeFile(path.join(directory,'src/express.d.ts'),`import 'express'; declare global { namespace Express { interface Request { operator:any } } }\n`);
 await fs.writeFile(path.join(directory,'src/nodemailer.d.ts'),`declare module 'nodemailer' { const mailer:{createTransport(options:any):{sendMail(input:any):Promise<{accepted:string[]}>}}; export default mailer; }\n`);
 await fs.writeFile(path.join(directory,'tsconfig.json'),JSON.stringify({compilerOptions:{allowJs:true,checkJs:true,noEmit:true,strict:true,noImplicitAny:false,useUnknownInCatchVariables:false,skipLibCheck:true,module:'NodeNext',moduleResolution:'NodeNext',target:'ES2023',types:['node']},include:['src/**/*']}));
 const result=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/lib/tsc.js'),'-p',path.join(directory,'tsconfig.json')],{encoding:'utf8'});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status||0;
}finally{await fs.rm(directory,{recursive:true,force:true});}
