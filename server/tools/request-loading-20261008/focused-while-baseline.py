"""Give timing checks the shared CPU budget while the baseline is paused."""
import os,signal,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[3]
run=sys.argv[1] if len(sys.argv)>1 else 'focused'
ids=subprocess.check_output(['docker','ps','--filter','label=com.docker.compose.project=mbbs-request-loading-baseline','--filter','label=com.docker.compose.service=test','--format','{{.ID}}']).decode().split()
assert len(ids)==1
signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
try:
    subprocess.run(['docker','pause',ids[0]],check=True,stdout=subprocess.DEVNULL)
    env={**os.environ,'REQUEST_LOADING_RUN':run,'REQUEST_LOADING_STAGE':'candidate'}
    with (root/f'server/test-artifacts/request-loading-performance-20261008/{run}-run.log').open('w') as log:
        result=subprocess.run(['bash','server/tools/request-loading-20261008/run.sh','node','tools/request-loading-20261008/checks.mjs'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
    print('focused_exit='+str(result.returncode),flush=True)
finally:
    subprocess.run(['docker','unpause',ids[0]],check=True,stdout=subprocess.DEVNULL)
