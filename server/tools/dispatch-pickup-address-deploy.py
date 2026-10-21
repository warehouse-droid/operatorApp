"""Deploy only the verified pickup override files over the pinned live image."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("executed-review-active-lines-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = "sha256:3b4871e91c7af7673dec1c611df6589fe392f047914fce407523b682c0507381"
release.RELEASE = release.SERVER / "deployments/dispatch-pickup-address-20260928"
release.ARTIFACT = release.SERVER / "test-artifacts/dispatch-pickup-address-release-20260928"
release.EVIDENCE = release.SERVER / "test-artifacts/dispatch-pickup-override"
release.FILES = ["public/dispatch.js", "public/dispatch.html", "src/dispatch-pickup-visits.js", "src/scm-dependency-plan-reconciler.js"]
release.IMAGE = "mbbs-operator-app:dispatch-pickup-address-20260928"
release.ROLLBACK = "mbbs-operator-app:rollback-dispatch-pickup-address-20260928"


def evidence():
    result = json.loads((release.EVIDENCE / "validation.json").read_text())
    assert result["passed"] and result["focusedTests"] == 26 and result["mutationsKilled"] == 5
    assert result["suites"]["current"] == result["suites"]["baseline"]
    assert result["static"]["static"] == "no new diagnostics"
    assert all(row["covered"] == row["total"] for row in result["changedLineCoverage"])
    for name, expected in result["sourceHashes"].items():
        assert release.digest(release.SERVER / name) == expected, "Verified source changed: " + name
    return {name: result["sourceHashes"][name] for name in release.FILES}


release.evidence = evidence


def docker(*args, **kwargs):
    # The shared release helper syntax-checks JS files. Verify the HTML asset
    # reference instead when it reaches this release's additional HTML file.
    if args[-2:] == ("--check", "public/dispatch.html"):
        args = (*args[:-2], "--input-type=module", "-e",
                "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.ok(readFileSync('public/dispatch.html','utf8').includes('/dispatch.js?v=20260928-pickup-override-v1'));")
    return release.core.docker(*args, **kwargs)


release.docker = docker


def check():
    info = release.load()
    release.current(info)
    source = release.ARTIFACT / "candidate"
    assert {name: release.digest(source / name) for name in info["candidateRuntime"]} == info["candidateRuntime"]
    check_name = "dispatch-pickup-address-release-20260928"
    environment = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(source), BIN_PLANNING_CHECK=check_name)
    with (release.ARTIFACT / "release-tests.log").open("wb") as log:
        subprocess.run(["bash", str(release.SERVER / "tools/bin-planning-test.sh"), "node", "tools/dispatch-pickup-address-check.mjs", "coverage"],
                       cwd=release.SERVER, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    hashes = json.loads((release.SERVER / "test-artifacts/mbt-bin-planning/checks" / check_name / "pickup-override/source-hashes.json").read_text())
    assert {name: hashes[name] for name in release.FILES} == info["files"]
    release.save("verified.json", {"passed": True, "imageId": info["imageId"], "focusedTests": 26})
    print(json.dumps({"candidateTestsPassed": 26, "imageId": info["imageId"]}), flush=True)


def verify():
    info = release.load()
    release.core.ready(info["imageId"])
    actual = release.core.metadata(release.APP)
    assert actual["configuration"] == info["app"]["configuration"]
    assert release.live_hashes() == info["files"]
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info["dependencies"]
    script = """import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; const expected=EXPECTED; const results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 const asset=await fetch(base+'/dispatch.js?v=20260928-pickup-override-v1',{signal:AbortSignal.timeout(15000)});
 assert.equal(asset.status,200);assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
 const shell=await fetch(base+'/dispatch.html',{signal:AbortSignal.timeout(15000)});
 assert.equal(shell.status,200);assert.ok((await shell.text()).includes('/dispatch.js?v=20260928-pickup-override-v1'));
 results.push({base,health:200,dispatchAssetMatches:true,htmlVersionMatches:true});
} console.log(JSON.stringify(results));""".replace("EXPECTED", json.dumps(info["files"]["public/dispatch.js"]))
    http = json.loads(docker("exec", "-i", release.APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "image": release.IMAGE, "imageId": info["imageId"], "configurationPreserved": True,
              "dependenciesUnchanged": True, "files": release.FILES, "http": http}
    release.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == "__main__":
    {"prepare": release.prepare, "check": check, "apply": release.apply, "verify": verify}[sys.argv[1]]()
