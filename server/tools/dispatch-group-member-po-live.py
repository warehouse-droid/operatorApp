"""Run the guarded route repair; --candidate previews changed code without deployment."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-artifacts/dispatch-group-member-po-20261001"
APP = "mbbs-operator-app-app-1"
mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
assert mode in ["preview", "apply", "verify"]
candidate = "--candidate" in sys.argv
assert not candidate or mode == "preview", "Candidate runs must roll back"
args = ["--" + mode]
if mode == "apply":
    args += ["--hash=" + json.loads((OUT / "live-preview.json").read_text())["beforeHash"]]
script = "process.argv.push(..." + json.dumps(args) + ");\n" + (ROOT / "tools/dispatch-group-member-po-live.mjs").read_text()
environment_file = None
try:
    if candidate:
        meta = json.loads(subprocess.check_output(["sudo", "-n", "docker", "inspect", APP]))[0]
        fd, environment_file = tempfile.mkstemp(prefix="group-po-env-", dir="/tmp")
        with os.fdopen(fd, "w") as stream:
            stream.write("\n".join(meta["Config"]["Env"]) + "\n")
        command = ["sudo", "-n", "docker", "run", "--rm", "-i", "--network", "container:" + APP,
                   "--volumes-from", APP + ":ro",
                   "--env-file", environment_file, "-v", str(ROOT / "src/dispatch-repository.js") + ":/app/src/dispatch-repository.js:ro",
                   "--entrypoint", "node", meta["Image"], "--input-type=module"]
    else:
        command = ["sudo", "-n", "docker", "exec", "-i", APP, "node", "--input-type=module"]
    result = subprocess.run(command, input=script, text=True, capture_output=True)
    logfile = OUT / ("live-" + mode + ".log")
    logfile.write_text(result.stdout + result.stderr)
    logfile.chmod(0o600)
    if result.returncode:
        errors = [line for line in result.stderr.splitlines() if len(line) < 500 and any(word in line for word in ["Error", "error:", "code:", "message:"])]
        raise RuntimeError("Route " + mode + " failed: " + " ".join(errors[-8:]))
    report = json.loads(result.stdout)
    output = OUT / ("live-" + mode + ".json")
    output.write_text(json.dumps(report, indent=2) + "\n")
    output.chmod(0o600)
    print(json.dumps(report))
finally:
    if environment_file:
        os.unlink(environment_file)
