"""Deploy only the four verified weight/sequence modules over the current app."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("executed-review-active-lines-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = release.core.metadata(release.APP)["imageId"]
release.RELEASE = release.SERVER / "deployments/dispatch-weight-save-20260929"
release.ARTIFACT = release.SERVER / "test-artifacts/dispatch-weight-save-release"
release.EVIDENCE = release.SERVER / "test-artifacts/dispatch-weight-save"
release.FILES = ["src/dispatch-plan-repository.js", "src/dispatch-load-assignment.js",
                 "src/dispatch-executed-order-review.js", "src/dispatch-planner-performance.js"]
release.IMAGE = "mbbs-operator-app:dispatch-weight-save-20260929"
release.ROLLBACK = "mbbs-operator-app:rollback-dispatch-weight-save-20260929"


def evidence():
    result = json.loads((release.EVIDENCE / "validation.json").read_text())
    assert result["passed"] and result["focused"]["status"] == 0
    assert result["suites"]["current"]["failures"] == result["suites"]["before"]["failures"]
    assert len(result["mutations"]) == 8 and all(row["killed"] for row in result["mutations"])
    assert result["static"]["noNewDiagnostics"]
    assert all(row["covered"] == row["total"] for row in result["changedLineCoverage"])
    for name, expected in result["sourceHashes"].items():
        assert release.digest(release.SERVER / name) == expected, "Verified source changed: " + name
    return {name: result["sourceHashes"][name] for name in release.FILES}


release.evidence = evidence


def check():
    info = release.load()
    release.current(info)
    source = release.ARTIFACT / "candidate"
    assert {name: release.digest(source / name) for name in info["candidateRuntime"]} == info["candidateRuntime"]
    check_name = "dispatch-weight-save-release-20260929"
    environment = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(source), BIN_PLANNING_CHECK=check_name)
    with (release.ARTIFACT / "release-tests.log").open("wb") as log:
        subprocess.run(["bash", str(release.SERVER / "tools/bin-planning-test.sh"), "node",
                        "tools/dispatch-weight-save-check.mjs", "focused"], cwd=release.SERVER, env=environment,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    artifact = release.SERVER / "test-artifacts/mbt-bin-planning/checks" / check_name / "dispatch-weight-save"
    hashes = json.loads((artifact / "source-hashes.json").read_text())
    assert {name: hashes[name] for name in release.FILES} == info["files"]
    focused = json.loads((artifact / "focused.json").read_text())
    assert focused["status"] == 0
    release.save("verified.json", {"passed": True, "imageId": info["imageId"], "focused": focused})
    print(json.dumps({"candidateTestsPassed": focused["passed"], "imageId": info["imageId"]}), flush=True)


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
 const auth=await fetch(base+'/api/dispatch/plans/341',{signal:AbortSignal.timeout(15000)});
 assert.equal(auth.status,401);results.push({base,health:200,unauthenticatedPlan:401});
} console.log(JSON.stringify(results));"""
    http = json.loads(release.docker("exec", "-i", release.APP, "node", "--input-type=module", input=script.encode()))
    replay = json.loads(subprocess.check_output([sys.executable, str(release.SERVER / "tools/dispatch-weight-save-live.py")], text=True))
    assert replay["savedWeight"] == replay["loadedWeight"] == 8784.966
    assert replay["sourceChanges"] == 0 and replay["weightOnlyPasses"] and replay["backupPassesExecutedGuard"]
    assert replay["actualQuantityChangeBlocked"] and replay["newReturnLoadRetained"]
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "image": release.IMAGE,
              "imageId": info["imageId"], "configurationPreserved": True, "dependenciesUnchanged": True,
              "http": http, "readOnlyReplay": replay, "files": release.FILES}
    release.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == "__main__":
    {"prepare": release.prepare, "check": check, "apply": release.apply, "verify": verify}[sys.argv[1]]()
