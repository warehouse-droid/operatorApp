"""Prepare/apply only the tested packing repository and rounding policy files."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "docker/backups/group-underpack-20260915"
ARTIFACT = ROOT / "server/test-artifacts/group-underpack-20260915"
FILES = ["src/delivery-repository.js", "src/delivery-packing-progress.js", "public/operator.js", "public/operator.html", "public/service-worker.js"]
BASE_IMAGE_ID = "sha256:5465c9b237d39d3f28b1faaa82b7707d8a87ce267a43f5c5c713bd9c7ce43077"
IMAGE = "mbbs-operator-app:group-underpack-20260915-v2"
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
    assert services[SERVICES[0]]["imageId"] == BASE_IMAGE_ID, "Live app changed; rebase first"
    assert services[SERVICES[1]]["imageId"] == "sha256:d3cadbfdbba46f6987425f27c967d4ef54eb777bd0d8eba25281b6bb1aead9be", "Live worker changed; rebase first"
    before = {file: sha(BACKUP / "baseline" / file) for file in FILES if (BACKUP / "baseline" / file).exists()}
    for container in SERVICES:
        assert hashes(container, list(before)) == before
    stage = BACKUP / "image"
    for file in FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BACKUP / "release" / file, target)
    (stage / "Dockerfile").write_text("FROM " + services[SERVICES[0]]["image"] + "\n" +
                                     "\n".join("COPY " + file + " /app/" + file for file in FILES) + "\n")
    manifest = {"services": services, "before": before, "after": {file: sha(stage / file) for file in FILES}, "image": IMAGE}
    (BACKUP / "deployment-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (BACKUP / "compose.override.yml").write_text(f"services:\n  app:\n    image: {IMAGE}\n  webhook-worker:\n    image: {IMAGE}\n")
    print(run("docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)))
    print(json.dumps({"prepared": IMAGE, "files": manifest["after"]}))


def apply():
    subprocess.run(["python3", str(ROOT / "server/tools/group-underpack-evidence.py")], check=True)
    manifest = json.loads((BACKUP / "deployment-manifest.json").read_text())
    evidence = json.loads((ARTIFACT / "evidence.json").read_text())
    for file in FILES:
        assert sha(BACKUP / "release" / file) == manifest["after"][file] == evidence["sourceHashes"][file]
    for container in SERVICES:
        assert metadata(container) == manifest["services"][container], "Runtime changed; rebase before applying"
        assert hashes(container, list(manifest["before"])) == manifest["before"]
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
