"""Read-only native recovery using the tested candidate reader on live records."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
script = (ROOT / 'tools/special-po-000041/inspect-orders.mjs').read_text()
script = script.replace("import {findLinkedSpecialPurchaseOrder} from './src/special-stock-native-po-adapter.js';",
                        "let findLinkedSpecialPurchaseOrder; const candidatePath='/tmp/special-po-000041-native-candidate.mjs';")
script = script.replace('try{\n  const ns=', 'try{\n  writeFileSync(candidatePath,' +
    json.dumps((ROOT / 'src/special-stock-native-po-adapter.js').read_text()) +
    ",{mode:0o600}); ({findLinkedSpecialPurchaseOrder}=await import(pathToFileURL(candidatePath).href));\n  const ns=")
script = script.replace('finally{unlinkSync(temporary);', 'finally{unlinkSync(temporary);unlinkSync(candidatePath);')
result = subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],
                        input=script.encode(),capture_output=True)
(ROOT / 'test-artifacts/special-po-000041/candidate-live.json').write_bytes(result.stdout)
(ROOT / 'test-artifacts/special-po-000041/candidate-live-errors.log').write_bytes(result.stderr)
if result.returncode:
    print(result.stderr.decode())
else:
    value=json.loads(result.stdout)
    assert value['initialRecovery']['passed'] and value['initialRecovery']['result']['id']==1042761
    print(json.dumps({'readOnly':True,'requestRef':value['requestRef'],'revision':value['revision'],
                      'recovery':value['initialRecovery'],'netSuiteWrites':0,'applicationWrites':0}))
raise SystemExit(result.returncode)
