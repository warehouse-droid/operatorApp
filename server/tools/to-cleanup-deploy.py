"""Build/apply the tested TO-only layer over the current live image."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "docker/backups/to-cleanup-20260915"
ARTIFACT = ROOT / "server/test-artifacts/to-cleanup-20260915"
FILES = ["src/dispatch-fulfilled-to-policy.js", "src/dispatch-fulfilled-to-repository.js",
         "src/dispatch-fulfilled-so-repository.js", "src/server.js", "src/receiving-repository.js",
         "public/dispatch.js", "public/dispatch.html"]
EXISTING = [name for name in FILES if (BACKUP / "current-runtime" / name).exists()]
SERVICES = {"app": "mbbs-operator-app-app-1", "worker": "mbbs-operator-app-webhook-worker-1"}
IMAGE = "mbbs-operator-app:to-cleanup-20260915-v1"

def run(*args):
    return subprocess.check_output(args, text=True)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def metadata(container):
    return json.loads(run("docker", "inspect", "--format",
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))

def hashes(container, files):
    output = run("docker", "exec", container, "sha256sum", *["/app/" + name for name in files])
    return {line.split()[1].removeprefix("/app/"): line.split()[0] for line in output.splitlines()}

parser = argparse.ArgumentParser()
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
manifest_file = BACKUP / "deployment-manifest.json"
if not args.apply:
    stage = BACKUP / "image"
    stage.mkdir(parents=True, exist_ok=True)
    before = {role: metadata(container) for role, container in SERVICES.items()}
    assert before["app"]["imageId"] == before["worker"]["imageId"], "Service images differ; prepare separate layers."
    expected = {name: sha(BACKUP / "current-runtime" / name) for name in EXISTING}
    for container in SERVICES.values():
        assert hashes(container, EXISTING) == expected, "Live source changed; rebase the tested TO layer first."
    for name in FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BACKUP / "release" / name, target)
    (stage / "Dockerfile").write_text("FROM " + before["app"]["image"] + "\n" +
        "\n".join("COPY " + name + " /app/" + name for name in FILES) + "\n")
    manifest = {"services": before, "before": expected,
                "after": {name: sha(stage / name) for name in FILES}, "image": IMAGE}
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n")
    (BACKUP / "compose.override.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n  webhook-worker:\n    image: " + IMAGE + "\n")
    print(run("docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)))
    print(json.dumps({"prepared": IMAGE, "files": manifest["after"]}))
else:
    manifest = json.loads(manifest_file.read_text())
    subprocess.run(["python3", str(ROOT / "server/tools/to-cleanup-evidence.py")], check=True)
    checks = json.loads((ARTIFACT / "final/results.json").read_text())
    assert checks and all(check["exitCode"] == 0 for check in checks), "Final gauntlet must pass."
    rehearsal = json.loads((ARTIFACT / "rehearsal.json").read_text())
    summary = json.loads((ARTIFACT / "production/summary.json").read_text())
    assert rehearsal["manifestSha256"] == summary["sha256"], "Rehearse the final current-data manifest."
    assert {name: sha(BACKUP / "release" / name) for name in FILES} == manifest["after"], "Tested source changed after image preparation."
    for role, container in SERVICES.items():
        assert metadata(container) == manifest["services"][role], "Deployment changed; rebase first."
        assert hashes(container, EXISTING) == manifest["before"]
    command = ["docker", "compose", "-p", "mbbs-operator-app"]
    for index, name in enumerate(manifest["services"]["app"]["configFiles"].split(",")):
        try:
            Path(name).read_bytes()
            config_file = name
        except PermissionError:
            # A prior deployment left a root-owned image override. Preserve its
            # exact contents in this task's backup without changing its owner.
            copied = BACKUP / f"prior-compose-override-{index}.yml"
            content = subprocess.check_output(["sudo", "-n", "cat", name])
            copied.write_bytes(content)
            config_file = str(copied)
        command += ["-f", config_file]
    command += ["-f", str(BACKUP / "compose.override.yml"), "up", "-d", "--no-build", "--no-deps", "app", "webhook-worker"]
    subprocess.run(command, cwd=ROOT, check=True)
    health = None
    for _ in range(40):
        try:
            with urlopen("http://127.0.0.1:3000/health", timeout=2) as response:
                assert response.status == 200
                health = json.load(response)
            break
        except Exception:
            time.sleep(0.5)
    assert health is not None, "Application did not recover; use the saved prior image metadata."
    for container in SERVICES.values():
        assert hashes(container, FILES) == manifest["after"]
    with urlopen("http://127.0.0.1:3000/dispatch.js?v=20260915-to-cleanup-v1", timeout=10) as response:
        assert hashlib.sha256(response.read()).hexdigest() == manifest["after"]["public/dispatch.js"]
    result = {"image": IMAGE, "health": health, "installed": manifest["after"]}
    (BACKUP / "deployment-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
