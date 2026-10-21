"""Execute a reviewed maintenance script through the existing app boundary.

Most scripts are read-only. Mutations must be explicit in the caller's tool
authorization; output is always retained privately, never dumped wholesale.
"""
import pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
source=(root/'tools/netsuite-attention-20261003'/sys.argv[1]).read_text().replace("from '../../src/","from './src/")
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
out=pathlib.Path('/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003')/sys.argv[2]
out.write_text(result.stdout);out.chmod(0o600)
if result.returncode:print(result.stderr);raise SystemExit(result.returncode)
print(str(out))
