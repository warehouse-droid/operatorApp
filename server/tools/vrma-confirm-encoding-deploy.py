"""Prepare/apply only the tested authorization and decoder files."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "docker/backups/vrma-confirm-encoding-20260915"
ARTIFACT = ROOT / "server/test-artifacts/vrma-confirm-encoding-20260915"
FILES = ["src/operator-yard-authorization.js", "src/operator-yard-route.js"]
BASE_IMAGE_ID = "sha256:f88721e506ea19ac24d47d0d5a21930236b9d32a421e4c21bde97450934e9240"
IMAGE = "mbbs-operator-app:vrma-confirm-encoding-20260915-v1"
SERVICES = ["mbbs-operator-app-app-1", "mbbs-operator-app-webhook-worker-1"]


def run(*args):
    return subprocess.check_output(args, text=True)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata(container):
    return json.loads(run("docker", "inspect", "--format",
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))


def hashes(container, files):
    output = run("docker", "exec", container, "sha256sum", *["/app/" + file for file in files])
    return {row.split()[1].removeprefix("/app/"): row.split()[0] for row in output.splitlines()}


def compose(manifest):
    command = ["docker", "compose", "-p", "mbbs-operator-app"]
    for index, filename in enumerate(manifest["services"][SERVICES[0]]["configFiles"].split(",")):
        try:
            Path(filename).read_bytes()
            selected = filename
        except PermissionError:
            copied = BACKUP / f"prior-compose-override-{index}.yml"
            copied.write_bytes(subprocess.check_output(["sudo", "-n", "cat", filename]))
            selected = str(copied)
        command += ["-f", selected]
    return command + ["-f", str(BACKUP / "compose.override.yml"), "up", "-d", "--no-build", "--no-deps", "app", "webhook-worker"]


def prepare():
    services = {container: metadata(container) for container in SERVICES}
    assert all(row["imageId"] == BASE_IMAGE_ID for row in services.values()), "Live runtime changed; rebase first"
    before = {FILES[0]: sha(BACKUP / "baseline" / FILES[0])}
    for container in SERVICES:
        assert hashes(container, [FILES[0]]) == before
    stage = BACKUP / "image"
    for file in FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BACKUP / "release-final" / file, target)
    (stage / "Dockerfile").write_text("FROM " + services[SERVICES[0]]["image"] + "\n" +
                                     "\n".join("COPY " + file + " /app/" + file for file in FILES) + "\n")
    manifest = {"services": services, "before": before, "after": {file: sha(stage / file) for file in FILES}, "image": IMAGE}
    (BACKUP / "deployment-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (BACKUP / "compose.override.yml").write_text(f"services:\n  app:\n    image: {IMAGE}\n  webhook-worker:\n    image: {IMAGE}\n")
    print(run("docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)))
    print(json.dumps({"prepared": IMAGE, "files": manifest["after"]}))


def apply():
    subprocess.run(["python3", str(ROOT / "server/tools/vrma-confirm-encoding-evidence.py")], check=True)
    manifest = json.loads((BACKUP / "deployment-manifest.json").read_text())
    evidence = json.loads((ARTIFACT / "evidence.json").read_text())
    for file in FILES:
        assert sha(BACKUP / "release-final" / file) == manifest["after"][file] == evidence["sourceHashes"][file]
    for container in SERVICES:
        assert metadata(container) == manifest["services"][container], "Runtime changed; rebase before applying"
        assert hashes(container, [FILES[0]]) == manifest["before"]
    subprocess.run(compose(manifest), cwd=ROOT, check=True)
    health = None
    for _ in range(40):
        try:
            with urlopen("http://127.0.0.1:3000/health", timeout=2) as response:
                assert response.status == 200
                health = json.load(response)
            break
        except Exception:
            time.sleep(0.5)
    assert health is not None, "Application did not recover; use the saved prior image metadata"
    for container in SERVICES:
        assert hashes(container, FILES) == manifest["after"]
    result = {"image": IMAGE, "health": health, "installed": manifest["after"], "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (BACKUP / "deployment-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply"])
    selected_mode = parser.parse_args().mode
    prepare() if selected_mode == "prepare" else apply()
