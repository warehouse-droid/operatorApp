#!/usr/bin/env python3
"""Release the Special Request adjustment editor display using the existing scoped release flow."""
import atexit
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
TASK = SERVER / "test-artifacts/special-adjustment-edit-20261015"
RELEASE = SERVER / "deployments/special-adjustment-edit-20261015"
OUT = TASK / "release-final"
IMAGE = "mbbs-operator-app:special-adjustment-edit-20261015"
FILES = ["public/sales-special-stock-requests.js", "public/sales-stock-requests.html"]
spec = importlib.util.spec_from_file_location("special_scm_release", SERVER / "tools/delivery-timeslot-notifications-release.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.TASK, base.OUT, base.RELEASE, base.IMAGE = TASK, OUT, RELEASE, IMAGE
core = base.core
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + "-rollback"
core.READ_NAME = "mbbs-special-adjustment-edit-reader"
core.CHECK_NAME = "mbbs-special-adjustment-edit-import"
base.tested_inputs = lambda: {name: core.sha((SERVER / name).read_bytes()) for name in FILES}


def capture():
    base.capture()
    patch = "".join("".join(difflib.unified_diff(
        (RELEASE / "before" / name).read_text().splitlines(True),
        (RELEASE / "candidate" / name).read_text().splitlines(True),
        fromfile="a/" + name, tofile="b/" + name)) for name in FILES)
    (RELEASE / "changes.patch").write_text(patch)


def validate():
    data = core.state()
    core.current(data)
    if (RELEASE / "validation.log").exists():
        attempt = str(time.time_ns())
        (RELEASE / "validation.log").rename(RELEASE / ("validation-" + attempt + ".log"))
        if OUT.exists():
            OUT.rename(TASK / ("attempt-" + attempt))
    environment = {**os.environ, "DELIVERY_ENHANCEMENTS_SOURCE": str(RELEASE / "candidate"),
                   "DELIVERY_ENHANCEMENTS_ARTIFACT": str(OUT), "DELIVERY_ENHANCEMENTS_SKIP_DB": "1",
                   "DELIVERY_ENHANCEMENTS_PROJECT": "mbbs-special-adjustment-edit-test"}
    command = ["bash", str(SERVER / "tools/delivery-request-enhancements-test.sh"),
               "env", "XDG_CONFIG_HOME=/tmp/chromium-config", "XDG_CACHE_HOME=/tmp/chromium-cache",
               "SPECIAL_CORRECTIONS_BROWSER_OUTPUT=test-artifacts/browser",
               "node", "--test", "--test-concurrency=1",
               "--test-name-pattern=Sales local adjustment|issued order adjustment|existing post-SO quantity adjustment|saved Sales line and decision notes|created and manually linked SOs",
               "test/mbt/integration/special-sales-request-corrections-browser.test.js",
               "test/mbt/integration/special-approval-browser.test.js",
               "test/mbt/integration/special-case-fields-browser.test.js",
               "test/mbt/integration/special-sales-items-copy-browser.test.js"]
    with (RELEASE / "validation.log").open("wb") as log:
        result = subprocess.run(command, cwd=SERVER.parent, env=environment,
                                stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, "adjustment editor checks failed; see validation.log"
    assert (OUT / "teardown.log").read_text().endswith("teardown_exit=0\n"), "Test teardown failed"
    output = (RELEASE / "validation.log").read_text()
    counts = {key: int(re.search(r"^# " + key + r" (\d+)$", output, re.M)[1])
              for key in ["tests", "pass", "fail", "skipped"]}
    assert counts["pass"] == 5 and counts["fail"] == 0
    assert counts["tests"] == counts["pass"] + counts["skipped"]
    core.current(data)
    core.save("validation-passed.json", {"passed": True, "at": core.now(),
              "candidateTreeHash": data["candidateTreeHash"], "counts": counts})
    print(json.dumps({"validated": True, **counts}), flush=True)


def verify():
    data = core.state()
    core.ready(data["candidateImageId"])
    live = core.metadata(core.APP)
    assert live["imageId"] == data["candidateImageId"] and live["configuration"] == data["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    actual = json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT))
    assert actual == data["candidateTree"], "Live runtime differs from the tested candidate"
    http = core.http_check({name: actual[name] for name in FILES}, ["/api/sales/special-stock-requests"])
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const page=await fetch(origin+'/sales/stock-requests',{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(page.status,200);
  const html=await page.text();
  const asset=html.match(/src="([^" ]*sales-special-stock-requests\.js[^" ]*)"/)[1];
  assert.ok(asset.includes('adjustmentEdit=20261015-v1'));
  const response=await fetch(origin+asset,{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),EXPECTED);
}
console.log(JSON.stringify({salesPageAndVersionedAssetVerified:true}));""".replace("EXPECTED", json.dumps(actual[FILES[0]]))
    page = json.loads(core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode(), timeout=60))
    core.save("deployment-result.json", {"deployed": True, "at": core.now(), "image": IMAGE,
              "imageId": live["imageId"], "candidateTreeHash": data["candidateTreeHash"], "changedFiles": FILES,
              "runtimeFilesVerified": len(actual), "configurationPreserved": True,
              "workerAndDependenciesUnchanged": True, "schemaChanged": False, "http": http, **page})
    print(json.dumps({"deployed": True, "http": http, **page}), flush=True)


def apply_when_idle():
    deadline = time.monotonic() + 50
    while True:
        try:
            base.apply()
            return
        except AssertionError as error:
            if not str(error).startswith("Wait for active business operations: ") or time.monotonic() >= deadline:
                raise
            print(str(error), flush=True)
            time.sleep(3)


base.verify = verify
if __name__ == "__main__":
    atexit.register(core.cleanup_manual)
    {"capture": capture, "rebase": base.rebase, "validate": validate,
     "build": core.build, "apply": apply_when_idle, "verify": verify}[sys.argv[1]]()
