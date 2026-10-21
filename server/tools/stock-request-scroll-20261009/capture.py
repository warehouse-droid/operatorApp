"""Capture public assets and read-only, de-identified request fixtures for Playwright."""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile
import sys

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/stock-request-scroll-20261009'
APP = 'mbbs-operator-app-app-1'
DOCKER = ['sudo', '-n', 'docker']
OUT.mkdir(parents=True, exist_ok=True)
after = len(sys.argv) > 1 and sys.argv[1] == 'after'
suffix = '-after' if after else ''
code = """import {getSpecialStockCase,listSpecialStockCases} from './src/special-stock-request-repository.js';
import {listScmStockRequests,getScmStockRequest,getSalesStockRequest} from './src/stock-request-repository.js';
import {closeDb} from './src/db.js';
try {
 const special=await getSpecialStockCase(162,{audience:'scm'});
 const specialSales=await getSpecialStockCase(162,{audience:'sales'});
 const specialQueue=await listSpecialStockCases({audience:'scm',limit:150});
 const regularQueue=await listScmStockRequests({limit:100});
 const regularRow=[...regularQueue].sort((a,b)=>b.lines.length-a.lines.length)[0];
 const regular=regularRow?await getScmStockRequest(regularRow.id):null;
 const regularSales=regularRow?await getSalesStockRequest(regularRow.id):null;
 console.log(JSON.stringify({special,specialSales,specialQueue,regular,regularSales,regularQueue}));
} finally { await closeDb(); }
"""
result = subprocess.check_output(DOCKER + ['exec', '-i', APP, 'node', '--input-type=module'], input=code.encode())
fixture = json.loads(result)
assert fixture['special']['requestRef'] == 'SPREQ-000063'

# Keep layout-sensitive string lengths and line wrapping, without personal identifiers.
private_keys = {'customerName', 'customerPhone', 'customerEmail', 'contactName', 'contactPhone',
                'deliveryAddress', 'salesInternalRemark', 'actorName', 'requestedByName', 'salesRepName'}
def sanitize(value):
    if isinstance(value, dict):
        return {key: ('viewer' if key == 'requestedBy' else
                     ''.join('X' if char.isalnum() else char for char in item) if key in private_keys and isinstance(item, str)
                     else sanitize(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value

(OUT / ('requests' + suffix + '.json')).write_text(json.dumps(sanitize(fixture), indent=2) + '\n')
archive = subprocess.check_output(DOCKER + ['exec', APP, 'tar', '-C', '/app/public', '-cf', '-', '.'])
public = OUT / ('live-public' + suffix)
public.mkdir(exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive)) as source:
    source.extractall(public, filter='data')
files = ['stock-requests.css', 'scm-stock-requests.html', 'sales-stock-requests.html', 'stock-request-view.js', 'special-stock-form-state.js']
hashes = {name: hashlib.sha256((public / name).read_bytes()).hexdigest() for name in files}
state = {'specialRef': fixture['special']['requestRef'], 'specialLines': len(fixture['special']['lines']),
         'specialQueue': len(fixture['specialQueue']), 'regularRef': fixture['regular']['requestRef'] if fixture['regular'] else None,
         'regularLines': len(fixture['regular']['lines']) if fixture['regular'] else 0,
         'regularQueue': len(fixture['regularQueue']), 'hashes': hashes,
         'localMatchesLive': {name: (SERVER / 'public' / name).read_bytes() == (public / name).read_bytes() for name in files}}
(OUT / ('capture' + suffix + '.json')).write_text(json.dumps(state, indent=2) + '\n')
print(json.dumps(state))
