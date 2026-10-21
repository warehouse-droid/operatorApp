import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const files=[['sales-stock-requests.html','/sales/stock-requests'],
  ['scm-stock-requests.html','/scm/stock-requests'],
  ['sales-stock-requests.js','/sales-stock-requests.js'],
  ['scm-stock-requests.js','/scm-stock-requests.js']];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for(const [file,path] of files) {
    const started=performance.now();
    const response=await fetch(base+path+'?requestLoadingCheck=20261008',{
      headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200,path);
    let body=await response.text();
    if(file.endsWith('.html')) {
      body=body.replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
    }
    assert.equal(hash(body),hash(fs.readFileSync('/app/public/'+file)),path);
    console.log(JSON.stringify({base,path,status:response.status,bodyMatchesRuntime:true,ms:Math.round(performance.now()-started)}));
  }
  for(const role of ['sales','scm']) {
    for(const kind of ['stock-requests','special-stock-requests']) {
      const path='/api/'+role+'/'+kind;
      const response=await fetch(base+path,{signal:AbortSignal.timeout(15000)});
      assert.equal(response.status,401,path);
      console.log(JSON.stringify({base,path,status:response.status,anonymousAccessDenied:true}));
    }
  }
}
