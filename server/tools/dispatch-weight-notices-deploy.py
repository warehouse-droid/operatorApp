"""Release the weight-notice policy without replacing unrelated live changes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("executed-review-active-lines-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = "sha256:969f44fc05a56dce442dc95c5fa6c6a2a179f9836064b23758d83259876d4a53"
release.RELEASE = release.SERVER / "deployments/dispatch-weight-notices-20260928"
release.ARTIFACT = release.SERVER / "test-artifacts/dispatch-weight-notices-release-20260928"
release.EVIDENCE = release.SERVER / "test-artifacts/dispatch-weight-notices"
release.FILES = ["src/dispatch-executed-order-review.js", "src/dispatch-executed-order-review-repository.js"]
release.IMAGE = "mbbs-operator-app:dispatch-weight-notices-20260928"
release.ROLLBACK = "mbbs-operator-app:rollback-dispatch-weight-notices-20260928"


def evidence():
    result = json.loads((release.EVIDENCE / "validation.json").read_text())
    assert result["passed"] and result["focusedTests"] == 28 and result["mutationsKilled"] == 4
    assert result["suites"]["current"]["failures"] == result["suites"]["baseline"]["failures"]
    assert result["static"]["static"] == "no new diagnostics"
    for name, expected in result["sourceHashes"].items():
        assert release.digest(release.SERVER / name) == expected, "Verified source changed: " + name
    return {name: result["sourceHashes"][name] for name in release.FILES}


release.evidence = evidence


def check():
    info = release.load()
    release.current(info)
    source = release.ARTIFACT / "candidate"
    assert {name: release.digest(source / name) for name in info["candidateRuntime"]} == info["candidateRuntime"]
    check_name = "dispatch-weight-notices-release-20260928"
    environment = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(source), BIN_PLANNING_CHECK=check_name)
    with (release.ARTIFACT / "release-tests.log").open("wb") as log:
        subprocess.run(["bash", str(release.SERVER / "tools/bin-planning-test.sh"), "node", "tools/dispatch-weight-review-check.mjs", "coverage"],
                       cwd=release.SERVER, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    hashes = json.loads((release.SERVER / "test-artifacts/mbt-bin-planning/checks" / check_name / "dispatch-weight-notices/source-hashes.json").read_text())
    assert {name: hashes[name] for name in release.FILES} == info["files"]
    release.save("verified.json", {"passed": True, "imageId": info["imageId"], "focusedTests": 28})
    print(json.dumps({"candidateTestsPassed": 28, "imageId": info["imageId"]}), flush=True)


def verify():
    info = release.load()
    release.core.ready(info["imageId"])
    actual = release.core.metadata(release.APP)
    assert actual["configuration"] == info["app"]["configuration"]
    assert release.live_hashes() == info["files"]
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info["dependencies"]
    script = """import assert from 'node:assert/strict'; const results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 const auth=await fetch(base+'/api/dispatch/plans/340/executed-order-reviews',{signal:AbortSignal.timeout(15000)});
 assert.equal(auth.status,401);results.push({base,health:200,unauthenticatedReviews:401});
} console.log(JSON.stringify(results));"""
    http = json.loads(release.docker("exec", "-i", release.APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "image": release.IMAGE, "imageId": info["imageId"], "configurationPreserved": True,
              "dependenciesUnchanged": True, "files": release.FILES, "http": http}
    release.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == "__main__":
    {"prepare": release.prepare, "check": check, "apply": release.apply, "verify": verify}[sys.argv[1]]()
