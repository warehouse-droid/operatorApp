"""Read-only operational timings; optional candidate modules live in this process only."""
import base64
import json
from pathlib import Path
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
files = ['src/server.js', 'src/order-dependency-repository.js',
         'src/dispatch-completion-repository.js', 'src/dispatch-history-mode.js',
         'src/scm-reconciliation-repository.js']
script = (server / 'tools/dispatch-latency-read.mjs').read_text()
if '--explain' in sys.argv:
    script = 'globalThis.dispatchLatencyExplain = true;\n' + script
if '--candidate' in sys.argv:
    candidate = server / 'deployments/dispatch-latency-20261023/candidate'
    sources = {'file:///app/' + name: (candidate / name).read_text() for name in files}
    loader = """let sources; export function initialize(data){sources=data;}
export async function load(url,context,next){
  if(Object.hasOwn(sources,url))return {format:'module',shortCircuit:true,source:sources[url]};
  return next(url,context);
}"""
    uri = 'data:text/javascript;base64,' + base64.b64encode(loader.encode()).decode()
    script = "import {register} from 'node:module';\nregister(" + json.dumps(uri) + ',{data:' + json.dumps(sources) + '});\n' + script
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app/tools',
                         'mbbs-operator-app-app-1', 'node', '--input-type=module'],
                        input=script, text=True, timeout=55)
sys.exit(result.returncode)
