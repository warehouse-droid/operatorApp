"""Execute read-only mapping audit with the candidate parser and current runtime readers."""
import pathlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parents[2]
source=(root/'tools/to-line-reference-20261003'/(sys.argv[2] if len(sys.argv)>2 else 'audit.mjs')).read_text()
source=source.replace("import {transferPostingOrderLine} from '../../src/netsuite-transfer-posting-line.js';",(root/'src/netsuite-transfer-posting-line.js').read_text())
source=source.replace("from '../../src/","from './src/")
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
target=root/'test-artifacts/to-line-reference-20261003'/sys.argv[1]
target.write_text(result.stdout)
if result.returncode: print(result.stderr);sys.exit(result.returncode)
print(str(target))
