"""Release the verified PO destination fix over the current application image."""
import datetime
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("executed-review-active-lines-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = release.core.metadata(release.APP)["imageId"]
release.RELEASE = release.SERVER / "deployments/dispatch-po-line-destinations-20260930-v2"
release.ARTIFACT = release.SERVER / "test-artifacts/dispatch-po-line-destinations-release-v2"
release.EVIDENCE = release.SERVER / "test-artifacts/dispatch-po-line-destinations"
release.FILES = ["src/dispatch-repository.js", "src/dispatch-planner-v2-repository.js", "src/dispatch-po-route-projection.js"]
release.IMAGE = "mbbs-operator-app:dispatch-po-line-destinations-20260930-v2"
release.ROLLBACK = "mbbs-operator-app:rollback-dispatch-po-line-destinations-20260930-v2"


def evidence():
    root = release.EVIDENCE
    assert json.loads((root / "focused.json").read_text())["status"] == 0
    if sys.argv[1] in ["apply", "verify"]:
        suites = json.loads((root / "suites.json").read_text())
        assert suites["current"]["failures"] == suites["before"]["failures"]
        assert suites["current"]["failed"] == suites["before"]["failed"]
    assert json.loads((root / "static.json").read_text())["noNewDiagnostics"]
    coverage = json.loads((root / "changed-line-coverage.json").read_text())
    assert all(row["covered"] == row["total"] for row in coverage)
    mutations = json.loads((root / "mutations.json").read_text())
    assert len(mutations) == 5 and all(row["killed"] for row in mutations)
    hashes = json.loads((root / "source-hashes.json").read_text())
    for name, expected in hashes.items():
        assert release.digest(release.SERVER / name) == expected, "Verified source changed: " + name
    return {name: hashes[name] for name in release.FILES}


release.evidence = evidence


def check():
    info = release.load()
    release.current(info)
    for row in release.FILES:
        assert release.digest(release.ARTIFACT / "candidate" / row) == info["files"][row]
    args = ["sudo", "-n", "docker", "run", "--rm", "--network", "none", "--user", "1000:1000",
            "-e", "MBBS_ENV_FILE=/nonexistent", "-e", "NODE_ENV=test"]
    source = release.ARTIFACT / "candidate"
    for name in ["src", "public", "test"]:
        args += ["-v", str(source / name) + ":/app/" + name + ":ro"]
    args += ["--entrypoint", "node", "mbbs-bin-planning-test:20260927", "--test", "--test-concurrency=1",
             "test/dispatch/unit/dispatch-po-line-destinations.test.js",
             "test/dispatch/unit/dispatch-po-route-residual.red.test.js",
             "test/dispatch/property/dispatch-po-route-residual.property.test.js",
             "test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js",
             "test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js"]
    with (release.ARTIFACT / "release-tests.log").open("wb") as log:
        subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True)
    release.save("verified.json", {"passed": True, "imageId": info["imageId"], "candidateRegressionTests": 30})
    print(json.dumps({"candidateTestsPassed": True, "imageId": info["imageId"]}), flush=True)


def verify():
    info = release.load()
    release.core.ready(info["imageId"])
    assert release.core.metadata(release.APP)["configuration"] == info["app"]["configuration"]
    assert release.live_hashes() == info["files"]
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info["dependencies"]
    script = """import assert from 'node:assert/strict'; const results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 const auth=await fetch(base+'/api/dispatch/v2/bootstrap?planId=342',{signal:AbortSignal.timeout(15000)});
 assert.equal(auth.status,401);results.push({base,health:200,anonymousBootstrap:401});
} console.log(JSON.stringify(results));"""
    http = json.loads(release.docker("exec", "-i", release.APP, "node", "--input-type=module", input=script.encode()))
    live = json.loads(subprocess.check_output([sys.executable,
        str(release.SERVER / "tools/dispatch-po-line-destinations-live.py"), "verify"], text=True))
    assert live["verified"] and live["compactFullDropoffs"] == 2
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": release.IMAGE, "imageId": info["imageId"], "configurationPreserved": True,
              "dependenciesUnchanged": True, "files": release.FILES, "http": http, "readOnlyVerification": live}
    release.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == "__main__":
    {"prepare": release.prepare, "check": check, "apply": release.apply, "verify": verify}[sys.argv[1]]()
