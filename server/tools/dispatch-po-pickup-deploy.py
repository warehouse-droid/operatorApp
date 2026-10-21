"""Release the verified SCM pickup lookup over the captured production image."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("special-workflow-documents-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = "sha256:fc682f9ba4ac6876b67af9ea68f59308a3a8acb8e7de75336aa1bd8dec52052c"
release.RELEASE = release.SERVER / "test-artifacts/po-pickup-yard-release-20260928"
release.EVIDENCE = release.SERVER / "test-artifacts/po-pickup-yard-20260928"
release.FILES = ["src/dispatch-repository.js", "src/dispatch-po-pickup-sql.js"]
release.IMAGE = "mbbs-operator-app:po-pickup-yard-20260928"
release.ROLLBACK = "mbbs-operator-app:rollback-po-pickup-yard-20260928"
release.migrate = lambda _info: None


def evidence():
    validation = json.loads((release.EVIDENCE / "validation.json").read_text())
    assert validation["passed"] and validation["tests"] == 47
    for file, digest in validation["sources"].items():
        assert release.core.digest((release.SERVER / file).read_bytes()) == digest, "Validated file changed: " + file
    assert release.core.digest((release.EVIDENCE / "fixed-test.log").read_bytes()) == validation["testLogHash"]
    return {file: validation["sources"][file] for file in release.FILES}


release.evidence = evidence


def prepare():
    os.umask(0o077)
    hashes = evidence()
    release.RELEASE.mkdir(mode=0o700, exist_ok=False)
    info = {"files": hashes,
            "services": {s: release.core.metadata(c) for s, c in release.SERVICES.items()},
            "dependencies": [release.core.metadata(c) for c in release.DEPENDENCIES]}
    for service, container in release.SERVICES.items():
        assert info["services"][service]["imageId"] == release.BASE_IMAGE
        assert release.docker("exec", container, "cat", "/app/src/dispatch-repository.js") == (
            release.EVIDENCE / "baseline/dispatch-repository.js").read_bytes()
        release.docker("exec", container, "test", "!", "-e", "/app/src/dispatch-po-pickup-sql.js")
    stage = release.RELEASE / "stage"
    for file in release.FILES:
        destination = stage / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(release.SERVER / file, destination)
    release.docker("tag", release.BASE_IMAGE, release.ROLLBACK)
    (stage / "Dockerfile").write_text("FROM " + release.ROLLBACK + "\n" + "".join(
        "COPY --chown=node:node " + file + " /app/" + file + "\n" for file in release.FILES))
    with (release.RELEASE / "build.log").open("wb") as log:
        subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false",
                        "-t", release.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    info["imageId"] = release.docker("image", "inspect", "--format", "{{.Id}}", release.IMAGE).decode().strip()
    for name, image in [("compose.release.yml", release.IMAGE), ("compose.rollback.yml", release.BASE_IMAGE)]:
        (release.RELEASE / name).write_text("services:\n" + "".join(
            "  " + service + ":\n    image: " + image + "\n" for service in release.SERVICES))
    actual = release.docker("run", "--rm", "--network", "none", "--entrypoint", "sha256sum",
                            release.IMAGE, *["/app/" + file for file in release.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in actual} == hashes
    smoke = "import {purchaseOrderPickupSql} from './src/dispatch-po-pickup-sql.js'; import {closeDb} from './src/db.js'; import './src/dispatch-repository.js'; if(!purchaseOrderPickupSql('po').joins.includes('scm_transport_schedule')) throw Error('Missing schedule lookup'); await closeDb();"
    release.docker("run", "--rm", "--network", "none", "--entrypoint", "node", release.IMAGE,
                   "--input-type=module", "-e", smoke)
    release.save("manifest.json", info)
    release.current(info)
    release.config_gate(info)
    print(json.dumps({"prepared": True, "imageId": info["imageId"], "files": release.FILES}), flush=True)


def apply():
    active = int(release.docker("exec", release.DEPENDENCIES[0], "psql", "-U", "mbbs_app", "-d", "mbbs_yard",
        "-XAt", "-v", "ON_ERROR_STOP=1", "-c",
        "SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'").decode().strip())
    assert active == 0, "Wait for the current driver action before restarting."
    release.apply()


if __name__ == "__main__":
    {"prepare": prepare, "apply": apply, "verify": release.verify}[sys.argv[1]]()
