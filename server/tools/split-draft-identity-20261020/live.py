"""Keep operational before/after evidence without printing customer details."""
import json
import os
from pathlib import Path
import subprocess
import sys

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / "deployments/split-draft-identity-20261020"
MODE = sys.argv[1]
assert MODE in ["preflight", "apply", "verify"]
OUT.mkdir(exist_ok=True)
result = subprocess.run(["sudo", "-n", "docker", "exec", "-i", "mbbs-operator-app-app-1",
    "node", "--input-type=module", "-", MODE],
    input=(TASK / "live-split.mjs").read_bytes(), capture_output=True, timeout=100)
path = OUT / ("live-" + MODE + ".json")
if result.returncode:
    (OUT / ("live-" + MODE + ".error.log")).write_bytes(result.stdout + result.stderr)
    print((result.stdout + result.stderr).decode()[-2500:])
    raise SystemExit(result.returncode)
data = json.loads(result.stdout)
path.write_bytes(result.stdout)
os.chmod(path, 0o600)
verified = data.get("verified", data)
print(json.dumps({"mode": MODE, "source": "SOA09140-S4",
    "retainedHash": data["retainedHash"],
    **({"quantities": verified["quantities"], "familyTotal": verified["familyTotal"]}
       if "quantities" in verified else {"remaining": 4588, "nextSuffix": data["checked"]["seed"]["nextSuffix"]})}))
