"""Capture current app screens with fictional data, build and check the user manual."""
import hashlib,json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/stock-requests/2026-09-29'
ART=ROOT/'test-artifacts/stock-request-manual-20260929'
OUT.mkdir(parents=True,exist_ok=True)

def docker(*args):
 return subprocess.check_output(['sudo','-n','docker',*args])

def capture():
 image=json.loads(docker('inspect','mbbs-operator-app-app-1'))[0]['Image']
 public=ART/'runtime/public'
 assert public.is_dir(),'First copy the current live /app/public folder into runtime/public.'
 files=sorted(public.rglob('*'));hashes={str(p.relative_to(public)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
 live_public=json.loads(docker('exec','mbbs-operator-app-app-1','node','-e',"const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};function walk(dir){for(const entry of fs.readdirSync('public/'+dir,{withFileTypes:true})){const path=dir+entry.name;if(entry.isDirectory())walk(path+'/');else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync('public/'+path)).digest('hex');}}walk('');console.log(JSON.stringify(hashes));"))
 assert hashes==live_public,'Screenshot assets must exactly match the current deployed public tree.'
 source_files=[p for p in (ROOT/'src').glob('*.js') if 'special-stock' in p.name or 'regular-stock' in p.name]+[ROOT/'src/field-sales/company-pdf.js']
 remote=json.loads(docker('exec','mbbs-operator-app-app-1','node','--input-type=module','-e',"import fs from 'node:fs';import crypto from 'node:crypto';const files=[...fs.readdirSync('src').filter(x=>x.includes('special-stock')||x.includes('regular-stock')),'field-sales/company-pdf.js'];console.log(JSON.stringify(Object.fromEntries(files.map(x=>[x,crypto.createHash('sha256').update(fs.readFileSync('src/'+x)).digest('hex')]))));"))
 for file in source_files: assert hashlib.sha256(file.read_bytes()).hexdigest()==remote[str(file.relative_to(ROOT/'src'))],file
 (ART/'source-evidence.json').write_text(json.dumps({'liveImageId':image,'publicFiles':hashes,'verifiedBackendFiles':remote,'screenshots':'Fictional training records; deployed UI assets; all requests intercepted locally; network disabled'},indent=2)+'\n')
 command=['sudo','-n','docker','run','--rm','--network','none','--read-only','--tmpfs','/tmp:uid=1000,gid=1000,mode=1777','--ipc=host',
  '-v',str(public)+':/app/public:ro','-v',str(ROOT/'tools/stock-request-manual-capture.mjs')+':/app/tools/stock-request-manual-capture.mjs:ro',
  '-v',str(OUT)+':/app/manual-out','mbbs-regular-v2:e2e','node','tools/stock-request-manual-capture.mjs']
 with (ART/'capture.log').open('wb') as log: subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=True)
 quote=ROOT/'test-artifacts/regular-stock-arrival/quote-packing/saved-quote-1.png'
 (OUT/'screenshots/11b-special-quote.png').write_bytes(quote.read_bytes())
 manifest=json.loads((OUT/'screenshots.json').read_text())
 manifest['captures'].append({'name':'11b-special-quote','filename':'screenshots/11b-special-quote.png','caption':'Generated special quote PDF with fictional packing quantities; verified deployed renderer.'})
 (OUT/'screenshots.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print('Screenshots captured.',flush=True)

def pdf():
 language=sys.argv[2] if len(sys.argv)>2 else 'en'
 assert language in ('en','zh-CN')
 command=['sudo','-n','docker','run','--rm','--network','none','--read-only','--tmpfs','/tmp:uid=1000,gid=1000,mode=1777','--ipc=host',
  '-v',str(ROOT/'tools/stock-request-manual-pdf.mjs')+':/app/tools/stock-request-manual-pdf.mjs:ro','-v',str(OUT)+':/app/manual-out',
  'mbbs-regular-v2:e2e','node','tools/stock-request-manual-pdf.mjs',language]
 logfile='pdf.log' if language=='en' else 'pdf-'+language+'.log'
 with (ART/logfile).open('wb') as log: subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=True)
 print('PDF rendered and manual links checked.',flush=True)
if __name__=='__main__':
 {'capture':capture,'pdf':pdf}[sys.argv[1]]()
