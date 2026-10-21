"""Publish a versioned Dispatch script reference after the verified app release."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("executed-review-active-lines-deploy.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
original = release.load()
original_result = json.loads((release.RELEASE / "deployment-result.json").read_text())
assert original_result["deployed"] and original_result["imageId"] == original["imageId"]
release.RELEASE = release.SERVER / "deployments/dispatch-source-replan-assets-20260928"
release.ARTIFACT = release.SERVER / "test-artifacts/executed-review-active-lines-assets-20260928"
release.BASE_IMAGE = original["imageId"]
release.IMAGE = "mbbs-operator-app:dispatch-source-replan-20260928-v2"
release.ROLLBACK = "mbbs-operator-app:rollback-dispatch-source-replan-assets-20260928"
old_version = b"/dispatch.js?v=20260927-readonly-loads-v3"
new_version = b"/dispatch.js?v=20260928-source-replan-v1"

os.umask(0o077)
info = {"app": release.core.metadata(release.APP), "dependencies": original["dependencies"],
        "files": original["files"], "baseline": original["files"]}
assert info["app"]["imageId"] == release.BASE_IMAGE
release.current(info)
release.RELEASE.mkdir(mode=0o700, exist_ok=False)
release.ARTIFACT.mkdir(mode=0o700, exist_ok=False)
before = release.docker("exec", release.APP, "cat", "/app/public/dispatch.html")
assert before.count(old_version) == 1
after = before.replace(old_version, new_version)
stage = release.ARTIFACT / "stage"
stage.mkdir()
(stage / "dispatch.html").write_bytes(after)
release.docker("tag", release.BASE_IMAGE, release.ROLLBACK)
(stage / "Dockerfile").write_text("FROM " + release.ROLLBACK + "\nCOPY --chown=node:node dispatch.html /app/public/dispatch.html\n")
with (release.ARTIFACT / "build.log").open("wb") as log:
    subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", release.IMAGE, str(stage)],
                   stdout=log, stderr=subprocess.STDOUT, check=True)
info["imageId"] = release.docker("image", "inspect", "--format", "{{.Id}}", release.IMAGE).decode().strip()
info["asset"] = {"file": "public/dispatch.html", "before": release.core.digest(before), "after": release.core.digest(after),
                 "version": new_version.decode()}
for name, image in [("compose.release.yml", release.IMAGE), ("compose.rollback.yml", release.ROLLBACK)]:
    (release.RELEASE / name).write_text("services:\n  app:\n    image: " + image + "\n")
assert release.docker("run", "--rm", "--network", "none", "--entrypoint", "cat", release.IMAGE, "/app/public/dispatch.html") == after
hashes = release.docker("run", "--rm", "--network", "none", "--entrypoint", "sha256sum", release.IMAGE,
                        *["/app/" + name for name in release.FILES]).decode().splitlines()
assert {row.split()[1].removeprefix("/app/"): row.split()[0] for row in hashes} == info["files"]
release.save("manifest.json", info)
release.save("verified.json", {"passed": True, "imageId": info["imageId"], "runtimeUnchanged": True,
                               "onlyChange": "Dispatch script URL version", "regressionEvidence": str(original_result["imageId"])})
release.apply()
assert release.docker("exec", release.APP, "cat", "/app/public/dispatch.html") == after
script = r'''
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const expected = EXPECTED;
const results=[];
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const page = await fetch(base + '/dispatch/planning', {headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(page.status,200);
  const html = await page.text();
  assert.ok(html.includes('/dispatch.js?v=20260928-source-replan-v1'));
  const asset = await fetch(base + '/dispatch.js?v=20260928-source-replan-v1', {signal:AbortSignal.timeout(15000)});
  assert.equal(asset.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
  results.push({base,page:200,versionedAsset:200,assetMatches:true});
}
console.log(JSON.stringify(results));
'''.replace("EXPECTED", json.dumps(info["files"]["public/dispatch.js"]))
result = json.loads(release.docker("exec", "-i", release.APP, "node", "--input-type=module", input=script.encode()))
release.save("asset-result.json", {"verified": True, "http": result})
print(json.dumps({"browserAssetVersionDeployed": True, "http": result}), flush=True)
