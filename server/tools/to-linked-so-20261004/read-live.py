"""Run a reviewed read-only inspection script through the live app boundary."""
import pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
private=pathlib.Path('/home/ubuntu/operatorapp-investigations/to-linked-so-20261004');private.mkdir(mode=0o700,exist_ok=True)
source=(root/'tools/to-linked-so-20261004'/sys.argv[1]).read_text().replace("from '../../src/","from './src/")
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
out=private/sys.argv[2];out.write_text(result.stdout);out.chmod(0o600)
if result.returncode:print(result.stderr[-3000:]);raise SystemExit(result.returncode)
print(str(out))
