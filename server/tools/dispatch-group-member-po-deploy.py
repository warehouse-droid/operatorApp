"""Release only the verified grouped SO PO projection over the current app image."""
import datetime
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("executed-review-active-lines-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = release.SERVER / "deployments/dispatch-group-member-po-20261001"
release.ARTIFACT = release.SERVER / "test-artifacts/dispatch-group-member-po-release-20261001"
release.EVIDENCE = release.SERVER / "test-artifacts/dispatch-group-member-po-20261001"
release.FILES = ["src/dispatch-repository.js"]
release.IMAGE = "mbbs-operator-app:dispatch-group-member-po-20261001"
release.ROLLBACK = "mbbs-operator-app:rollback-dispatch-group-member-po-20261001"
release.BASE_IMAGE = (release.core.metadata(release.APP)["imageId"] if sys.argv[1] == "prepare"
                      else release.load()["app"]["imageId"])


def evidence():
    root = release.EVIDENCE
    assert json.loads((root / "focused.json").read_text())["exitCode"] == 0
    assert json.loads((root / "suite-health.json").read_text())["exitCode"] == 0
    suites = json.loads((root / "suites.json").read_text())
    assert suites["baseline-suite"]["failures"] == suites["current-suite"]["failures"]
    assert json.loads((root / "static.json").read_text())["noNewDiagnostics"]
    assert all(row["count"] > 0 for row in json.loads((root / "changed-line-coverage.json").read_text()))
    mutants = json.loads((root / "mutations.json").read_text())
    assert len(mutants) == 6 and all(row["killed"] for row in mutants)
    preview = json.loads((root / "live-preview.json").read_text())
    assert preview["rolledBack"] and preview["unrelatedStopsUnchanged"] and preview["allocationsUnchanged"]
    hashes = json.loads((root / "source-hashes.json").read_text())
    for name, digest in hashes.items():
        assert release.digest(release.SERVER / name) == digest, "Verified source changed: " + name
    return {name: hashes[name] for name in release.FILES}


def check():
    info = release.load()
    release.current(info)
    source = release.ARTIFACT / "candidate"
    args = ["sudo", "-n", "docker", "run", "--rm", "--network", "none", "-e", "MBBS_ENV_FILE=/nonexistent", "-e", "NODE_ENV=test"]
    for name in ["src", "public", "test"]:
        args += ["-v", str(source / name) + ":/app/" + name + ":ro"]
    args += ["--entrypoint", "node", "mbbs-return-batch-browser-test:20260918", "--test", "--test-concurrency=1",
             "test/dispatch/unit/dispatch-group-member-po.test.js",
             "test/dispatch/unit/dispatch-po-line-destinations.test.js",
             "test/dispatch/unit/dispatch-po-route-residual.red.test.js",
             "test/dispatch/property/dispatch-po-route-residual.property.test.js",
             "test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js",
             "test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js"]
    with (release.ARTIFACT / "release-tests.log").open("wb") as log:
        subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True)
    assert {name: release.digest(source / name) for name in info["candidateRuntime"]} == info["candidateRuntime"]
    release.save("verified.json", {"passed": True, "imageId": info["imageId"]})
    print(json.dumps({"candidateTestsPassed": True, "imageId": info["imageId"]}), flush=True)


def verify():
    info = release.load()
    release.core.ready(info["imageId"])
    assert release.core.metadata(release.APP)["configuration"] == info["app"]["configuration"]
    assert release.live_hashes() == info["files"]
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info["dependencies"]
    script = """import assert from 'node:assert/strict';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 const anonymous=await fetch(base+'/api/dispatch/v2/bootstrap?planId=343',{signal:AbortSignal.timeout(15000)});
 assert.equal(anonymous.status,401);
} console.log(JSON.stringify({localHealth:200,publicHealth:200,anonymousBootstrap:401}));"""
    http = json.loads(release.docker("exec", "-i", release.APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": release.IMAGE, "imageId": info["imageId"], "configurationPreserved": True,
              "dependenciesUnchanged": True, "files": release.FILES, "http": http}
    release.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


release.evidence = evidence
release.verify = verify
if __name__ == "__main__":
    {"prepare": release.prepare, "check": check, "apply": release.apply, "verify": verify}[sys.argv[1]]()
