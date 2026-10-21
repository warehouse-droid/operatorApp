"""Release the RA unit/draft changes while preserving the exact current app images."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
spec = importlib.util.spec_from_file_location("return_release", SERVER / "tools/return-stored-orderline-deploy.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.RELEASE = Path(os.environ.get("RETURN_RA_DRAFT_RELEASE", "/home/ubuntu/operatorapp-deploy-backups/return-ra-draft-20260930"))
base.ARTIFACT = SERVER / "test-artifacts/return-ra-units-draft"
FILES = sorted(["src/return-batch-ra-domain.js", "src/return-batch-ra-service.js", "src/return-netsuite.js",
    "src/return-repository.js", "src/return-submission-draft.js", "src/server.js", "public/operator.js",
    "public/operator.html", "public/service-worker.js", "migrations/243_return_draft_authorizations.sql"])
base.FILES = FILES
CAPTURE = Path("/home/ubuntu/operatorapp-deploy-backups/return-ra-units-draft-20260930/baseline")
VERSION = "20260930-return-ra-draft-v1"
OLD_SERVER = '    ...(error.requiredReturnLocation ? { requiredReturnLocation: error.requiredReturnLocation } : {}),\n'
NEW_SERVER = OLD_SERVER + '    ...(error.draftId ? { draftId: error.draftId, draftSaved: error.draftSaved === true } : {}),\n'
OLD_UI = '    const code = String(error.payload?.code || "");\n    returnValidationMessage = code === "CROSS_YARD_RETURN_BLOCKED"'
NEW_UI = '    const code = String(error.payload?.code || "");\n    if (code === "RETURN_SUBMISSION_DRAFT" && error.payload?.draftId) {\n      returnDraftId = String(error.payload.draftId);\n      if (error.payload.draftSaved) returnDirty = false;\n    }\n    returnValidationMessage = code === "CROSS_YARD_RETURN_BLOCKED"'
SHARED = {"src/server.js": (OLD_SERVER, NEW_SERVER), "public/operator.js": (OLD_UI, NEW_UI)}
TESTS = ["unit/return-stored-orderline", "integration/return-stored-orderline", "unit/return-batch-ra-domain",
    "unit/return-ra-workflow", "unit/return-ra-client", "integration/return-batch-ra", "integration/return-ra-workflow",
    "integration/stock-return-draft-insert", "integration/netsuite-order-line-storage", "integration/operator-direct-orderline",
    "unit/return-rest-units", "integration/return-failed-draft"]


def hashes():
    result = {}
    for file in FILES:
        data = (SERVER / file).read_bytes()
        if file in SHARED:
            assert SHARED[file][1] in data.decode(), "Scoped shared patch missing: " + file
            data = SHARED[file][1].encode()
        elif file in ["public/operator.html", "public/service-worker.js"]:
            assert VERSION in data.decode()
            data = (file + ":" + VERSION).encode()
        result[file] = base.digest(data)
    return result


base.hashes = hashes


def patch_shared(file, data):
    text = data.decode()
    if file in SHARED:
        old, new = SHARED[file]
        assert text.count(old) == 1 and new not in text, "Live shared anchor changed: " + file
        return text.replace(old, new).encode()
    if file == "public/operator.html":
        text, count = re.subn(r'(/operator\.js\?v=)[^"\s]+', r'\g<1>' + VERSION, text)
        assert count == 1
    elif file == "public/service-worker.js":
        text, count = re.subn(r'^const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
        text, count = re.subn(r'(/operator\.js\?v=)[^"\s]+', r'\g<1>' + VERSION, text)
        assert count == 1
    else:
        raise AssertionError(file)
    return text.encode()


def prepare():
    os.umask(0o077)
    base.RELEASE.mkdir(parents=True, exist_ok=False)
    base.ARTIFACT.mkdir(parents=True, exist_ok=True)
    data = {"workspace": hashes(), "dependencies": [base.metadata(c) for c in base.DEPENDENCIES], "services": {}}
    for service, container in base.SERVICES.items():
        before = base.metadata(container)
        baseline = base.RELEASE / ("baseline-" + service)
        baseline.mkdir()
        for folder in ["src", "public", "migrations"]:
            base.docker("cp", container + ":/app/" + folder, str(baseline / folder))
        for file in ["package.json", "package-lock.json"]:
            base.docker("cp", container + ":/app/" + file, str(baseline / file))
        subprocess.run(["sudo", "-n", "chown", "-R", str(os.getuid()) + ":" + str(os.getgid()), str(baseline)], check=True)
        assert base.metadata(container) == before
        candidate = base.RELEASE / ("candidate-" + service)
        shutil.copytree(baseline, candidate)
        stage = base.RELEASE / ("stage-" + service)
        for file in FILES:
            target = candidate / file
            target.parent.mkdir(parents=True, exist_ok=True)
            if file in SHARED or file in ["public/operator.html", "public/service-worker.js"]:
                target.write_bytes(patch_shared(file, (baseline / file).read_bytes()))
            else:
                original = CAPTURE / container / file
                if original.exists():
                    assert (baseline / file).read_bytes() == original.read_bytes(), "Return baseline changed: " + file
                else:
                    assert not (baseline / file).exists(), "New file already exists: " + file
                shutil.copy2(SERVER / file, target)
            (stage / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, stage / file)
        old, tree = base.files_at(baseline), base.files_at(candidate)
        assert sorted(file for file in tree if tree[file] != old.get(file)) == FILES
        assert not set(old) - set(tree)
        image = "mbbs-operator-app:" + base.RELEASE.name + "-" + service
        tag = "mbbs-operator-app:rollback-" + base.RELEASE.name + "-" + service
        (stage / "Dockerfile").write_text("FROM " + tag + "\n" + "".join("COPY " + file + " /app/" + file + "\n" for file in FILES))
        data["services"][service] = {"before": before, "image": image, "baseTag": tag, "tree": tree, "changedFiles": FILES}
    candidate = base.RELEASE / "candidate-app"
    for folder in ["test", "tools", "contracts"]:
        (candidate / folder).symlink_to(SERVER / folder, target_is_directory=True)
    for file in ["tsconfig.mbt.json", "eslint.mbt.config.js"]:
        (candidate / file).symlink_to(SERVER / file)
    for name, key in [("compose.release.yml", "image"), ("compose.rollback.yml", "before")]:
        content = "services:\n"
        for service, row in data["services"].items():
            value = row["image"] if key == "image" else row["before"]["imageId"]
            content += "  " + service + ":\n    image: " + value + "\n"
        (base.RELEASE / name).write_text(content)
    base.save("manifest.json", data)
    print(json.dumps({"prepared": True, "changedFiles": FILES}), flush=True)


def candidate_tests():
    data = base.state()
    base.current(data)
    artifact = SERVER / "test-artifacts/return-stored-orderline/ra-draft"
    for file in FILES:
        original = base.RELEASE / "baseline-app" / file
        if original.exists():
            target = artifact / "baseline" / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
    environment = dict(os.environ, RETURN_STORED_SOURCE_ROOT=str(base.RELEASE / "candidate-app"), RETURN_STORED_TEST_SUBNET="10.254.69.0/24")
    with (base.RELEASE / "candidate-tests.log").open("wb") as output:
        result = subprocess.run(["bash", str(SERVER / "tools/return-stored-orderline-isolated.sh"), "node", "tools/return-ra-draft-check.mjs"],
            cwd=ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT, timeout=300)
    assert result.returncode == 0, "Candidate checks failed; see candidate-tests.log."
    shutil.copy2(artifact / "checks.json", base.ARTIFACT / "checks.json")
    evidence = json.loads((base.ARTIFACT / "checks.json").read_text())
    assert evidence["passed"] and evidence["counts"]["tests"] == 111
    evidence.update(sourceHashes=data["workspace"], testedSource="captured live images plus scoped return changes")
    base.save("candidate-tests.json", evidence)
    (base.ARTIFACT / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence), flush=True)


def migrate():
    data = base.state()
    base.current(data)
    evidence = json.loads((base.ARTIFACT / "evidence.json").read_text())
    assert evidence["passed"] and evidence["sourceHashes"] == data["workspace"]
    base.config_check(data)
    file = "243_return_draft_authorizations.sql"
    sql = (SERVER / "migrations" / file).read_text()
    result = base.core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';\n" + sql +
        "\nINSERT INTO schema_migrations(filename) VALUES('" + file + "') ON CONFLICT DO NOTHING; COMMIT;")
    base.save("schema.json", {"applied": True, "migration": file, "sourceHash": data["workspace"]["migrations/" + file], "backwardCompatible": True})
    print(json.dumps({"schemaApplied": True, "migration": file}), flush=True)


def apply():
    migrate()
    base.apply()


if __name__ == "__main__":
    {"prepare": prepare, "build": base.build, "candidate-tests": candidate_tests, "candidate-probe": base.candidate_probe,
     "migrate": migrate, "apply": apply, "verify": base.verify}[sys.argv[1]]()
