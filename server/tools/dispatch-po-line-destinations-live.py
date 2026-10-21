"""Preview, repair, and verify SN1401728 through existing transactional save guards."""
import json
from pathlib import Path
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
artifact = server / "test-artifacts/dispatch-po-line-destinations"
artifact.mkdir(exist_ok=True)
mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
assert mode in ["preview", "repair", "verify"]
arguments = [] if mode == "verify" else ["--" + mode]
if mode == "repair":
    preview = json.loads((artifact / "live-preview.json").read_text())
    arguments.append("--revision=" + str(preview["beforeRevision"]))
script = "process.argv.push(..." + json.dumps(arguments) + ");\n" + (server / "tools/dispatch-po-line-destinations-live.mjs").read_text()
result = subprocess.run(["sudo", "-n", "docker", "exec", "-i", "mbbs-operator-app-app-1", "node", "--input-type=module"],
                        input=script, text=True, capture_output=True)
if result.returncode:
    errors = [line for line in result.stderr.splitlines() if len(line) < 500 and any(word in line for word in ["Error", "error:", "code:", "message:"])]
    raise RuntimeError("SN1401728 " + mode + " failed: " + " ".join(errors[-5:]))
report = json.loads(result.stdout)
target = artifact / ("live-" + mode + ".json")
target.write_text(json.dumps(report, indent=2) + "\n")
target.chmod(0o600)
print(json.dumps({key: value for key, value in report.items() if key != "backup"}))
