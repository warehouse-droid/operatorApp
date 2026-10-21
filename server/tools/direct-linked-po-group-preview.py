"""Execute frozen candidate schedule queries against production, read-only."""
import importlib.util
import subprocess
import time
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('group_preview_release',SERVER/'tools/direct-linked-po-group-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def run():
    state = release.base.state()
    release.base.current(state)
    target = '/tmp/direct-linked-po-group-preview-20261002-v2'
    release.docker('exec',release.base.APP,'node','-e',
        "const fs=require('fs'),p=process.argv[1];if(fs.existsSync(p))fs.renameSync(p,p+'-preserved-'+Date.now());fs.mkdirSync(p)",target)
    for name in ['src','public','package.json']:
        release.docker('cp',str(release.RELEASE/'candidate'/name),release.base.APP+':'+target+'/'+name)
    release.docker('exec',release.base.APP,'node','-e',
        "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",target)
    script = (SERVER/'tools/direct-linked-po-group-live.mjs').read_text().replace('"./src/','"file://'+target+'/src/')
    assert '"./src/' not in script
    release.docker('exec','-i',release.base.APP,'node','-e',
        "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0))",target+'/preview.mjs',input=script.encode())
    wrapper = 'await import("/app/src/config.js");await import("file://'+target+'/preview.mjs");'
    try:
        output = release.docker('exec','-i','-e','COMBINED_RELEASE_VERIFY=1',release.base.APP,
            'node','--input-type=module',input=wrapper.encode(),timeout=90,stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        (release.RELEASE/('preview-failed-'+str(time.time_ns())+'.log')).write_bytes(error.output+b'\n'+error.stderr)
        raise
    (release.RELEASE/'live-candidate-preview.log').write_bytes(output)
    result = json.loads(output)
    assert result['readOnly'] and result['statementTimeoutSeconds']==10
    assert result['fullScheduleProjectionMs'] is not None and result['fullScheduleProjectionMs']<10000
    assert result['activeScheduleMs'] is not None and result['activeScheduleMs']<10000
    result['sourceHashes'] = state['sourceHashes']
    release.save('live-candidate-preview.json',result)
    release.base.current(state)
    print(json.dumps({'previewPassed':True,'orders':result['orders'],'elapsedMs':result['elapsedMs'],
        'fullScheduleProjectionMs':result['fullScheduleProjectionMs'],'activeScheduleMs':result['activeScheduleMs'],
        'receiptJobs':result['receiptJobs']}),flush=True)


if __name__=='__main__':
    run()
