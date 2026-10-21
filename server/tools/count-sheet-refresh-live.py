"""Read current HUNT balances and evaluate the tested packing query without installing it."""
import base64
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[1]
packed=(root/'src/inventory-packed-stock.js').read_text().replace("'./db.js'","'file:///app/src/db.js'").replace("'./netsuite-closed-order-policy.js'","'file:///app/src/netsuite-closed-order-policy.js'")
module='data:text/javascript;base64,'+base64.b64encode(packed.encode()).decode()
script=(root/'tools/count-sheet-refresh-live.mjs').read_text().replace("'../src/db.js'","'./src/db.js'").replace("'../src/netsuite.js'","'./src/netsuite.js'").replace("'../src/inventory-packed-stock.js'",repr(module))
subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=script.encode(),check=True)
