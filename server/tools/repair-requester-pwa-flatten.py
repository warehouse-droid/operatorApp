#!/usr/bin/env python3
"""Repackage the verified release without its accumulated overlay ancestry."""
import io,json,os,runpy,signal,subprocess,sys,tarfile,uuid
from pathlib import Path
r=runpy.run_path(str(Path(__file__).with_name('repair-requester-pwa-release.py')))
b,scope,out=r['base'],r['scope'],r['OUT']

def interrupted(signum,_frame):raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)

def main():
 if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
  subprocess.run(['sudo','-n','python3',str(scope['SERVER'].parent/'docker/retention/retention.py'),'run','--root','/tmp','--',sys.executable,__file__,*sys.argv[1:]],check=True);return
 prepared=b['ensure_sources']();capture=json.loads((out/'capture.json').read_text());validation=json.loads((out/'validation.json').read_text());assert validation['passed'] and validation['sourceHashes']==prepared['sourceHashes']
 assert {k:b['metadata'](n) for k,n in b['SERVICES'].items()}==capture
 original=json.loads(b['docker']('image','inspect',capture['app']['imageId']))[0];cfg=original['Config'];directory=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'flat-image';directory.mkdir();archive=directory/'rootfs.tar';name='mbbs-repair-package-'+uuid.uuid4().hex[:12]
 limits=['--init','--cgroup-parent=mbbs-tests.slice','--memory=1g','--memory-swap=1g','--pids-limit=64','--cpus=1','--tmpfs=/tmp:rw,nosuid,nodev,size=64m','--network=none','--label=com.mbbs.lifecycle=disposable-test']
 if '--verify-existing' not in sys.argv:
  try:
   # Export an unstarted, clean container: never export live runtime state/data.
   b['docker']('create','--rm','--name',name,*limits,'--entrypoint=/bin/true',capture['app']['imageId'])
   content=io.BytesIO()
   with tarfile.open(fileobj=content,mode='w') as tar:
    for file in r['FILES']:
     def owner(info):info.uid=info.gid=0;info.uname=info.gname='';return info
     tar.add(out/'candidate'/file,arcname=file,recursive=False,filter=owner)
   b['docker']('cp','-',name+':/app',data=content.getvalue())
   with archive.open('xb') as output:
    archive.chmod(0o600);subprocess.run(['sudo','-n','docker','export',name],check=True,stdout=output)
  finally:
   subprocess.run(['sudo','-n','docker','rm','-fv',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   assert not b['docker']('ps','-aq','--filter','name=^/'+name+'$')
  lines=['FROM scratch','ADD rootfs.tar /']
  for value in cfg.get('Env') or []:
   key,value=value.split('=',1);lines.append('ENV '+key+'='+json.dumps(value))
  if cfg.get('WorkingDir'):lines.append('WORKDIR '+cfg['WorkingDir'])
  if cfg.get('User'):lines.append('USER '+cfg['User'])
  if cfg.get('Shell'):lines.append('SHELL '+json.dumps(cfg['Shell']))
  if cfg.get('Entrypoint') is not None:lines.append('ENTRYPOINT '+json.dumps(cfg['Entrypoint']))
  if cfg.get('Cmd') is not None:lines.append('CMD '+json.dumps(cfg['Cmd']))
  for port in cfg.get('ExposedPorts') or {}:lines.append('EXPOSE '+port)
  for key,value in (cfg.get('Labels') or {}).items():lines.append('LABEL '+key+'='+json.dumps(value))
  if cfg.get('Volumes'):lines.append('VOLUME '+json.dumps(list(cfg['Volumes'])))
  if cfg.get('StopSignal'):lines.append('STOPSIGNAL '+cfg['StopSignal'])
  health=cfg.get('Healthcheck')
  if health:
   if health['Test'][0]=='NONE':lines.append('HEALTHCHECK NONE')
   else:
    options=[]
    for key,flag in [('Interval','interval'),('Timeout','timeout'),('StartPeriod','start-period'),('StartInterval','start-interval')]:
     if health.get(key):options.append('--'+flag+'='+str(health[key])+'ns')
    if health.get('Retries'):options.append('--retries='+str(health['Retries']))
    test=health['Test'];command=test[1] if test[0]=='CMD-SHELL' else json.dumps(test[1:]);lines.append('HEALTHCHECK '+' '.join(options)+' CMD '+command)
  for trigger in cfg.get('OnBuild') or []:lines.append('ONBUILD '+trigger)
  (directory/'Dockerfile').write_text('\n'.join(lines)+'\n')
  result=subprocess.run(['sudo','-n','docker','build','--network=none','-t',scope['IMAGE'],str(directory)],capture_output=True,text=True)
  assert result.returncode==0,(result.stdout+result.stderr)[-2500:]
 flat=json.loads(b['docker']('image','inspect',scope['IMAGE']))[0];assert len(flat['RootFS']['Layers']) in (1,2), 'Unexpected flattened image depth'
 for key in ['Env','User','WorkingDir','Entrypoint','Cmd','Shell','Healthcheck','ExposedPorts','Labels','Volumes','StopSignal','OnBuild']:
  before,after=cfg.get(key),flat['Config'].get(key)
  if key=='Env':before,after=sorted(before or []),sorted(after or [])
  assert before==after,('Image configuration changed',key)
 expected={}
 for file in (out/'candidate').rglob('*'):
  if file.is_file():expected['/app/'+str(file.relative_to(out/'candidate'))]=b['sha'](file)
 manifest=directory/'expected.json';manifest.write_text(json.dumps(expected))
 code="const fs=require('node:fs'),c=require('node:crypto'),m=JSON.parse(fs.readFileSync('/release-manifest.json'));for(const [p,h] of Object.entries(m)){if(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==h)throw Error('Source mismatch: '+p)}console.log(JSON.stringify({flattenedSourceFilesVerified:Object.keys(m).length}));"
 checked=b['docker']('run','--rm','--name',name+'-verify',*limits,'--entrypoint=node','--mount','type=bind,src='+str(manifest)+',dst=/release-manifest.json,readonly',scope['IMAGE'],'--max-old-space-size=256','-e',code);print(checked,flush=True)
 b['save'](out/'flatten-audit.json',{'previousImageId':original['Id'],'previousLayers':len(original['RootFS']['Layers']),'imageId':flat['Id'],'layers':len(flat['RootFS']['Layers']),'configurationPreserved':True,'allCandidateFilesVerified':len(expected),'sourceHashes':prepared['sourceHashes']})
 b['save'](out/'built.json',{'image':scope['IMAGE'],'imageId':flat['Id'],'sourceHashes':prepared['sourceHashes'],'flattened':True})
 print(json.dumps({'flattened':True,'layers':len(flat['RootFS']['Layers']),'configurationPreserved':True,'sourceFiles':len(expected)}))

if __name__=='__main__':main()
