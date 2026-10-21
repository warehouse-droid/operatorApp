#!/usr/bin/env python3
"""Validate and deploy the fixed sidebar preferences gear only."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
TASK = SERVER / "test-artifacts/app-sidebar-preferences-gear-20261014"
RELEASE = SERVER / "deployments/app-sidebar-preferences-gear-20261014"
OUT = TASK / "release-final"
IMAGE = "mbbs-operator-app:app-sidebar-preferences-gear-20261014"
FILES = ["public/app-sidebar.js"]
spec = importlib.util.spec_from_file_location("sidebar_gear_release", SERVER / "tools/delivery-timeslot-notifications-release.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.TASK, base.OUT, base.RELEASE, base.IMAGE = TASK, OUT, RELEASE, IMAGE
core = base.core
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + "-rollback"
core.READ_NAME = "mbbs-sidebar-preferences-gear-reader"
core.CHECK_NAME = "mbbs-sidebar-preferences-gear-import"
base.tested_inputs = lambda: {name: core.sha((SERVER / name).read_bytes()) for name in FILES}


def validate():
    data = core.state()
    core.current(data)
    environment = {**os.environ, "DELIVERY_ENHANCEMENTS_SOURCE": str(RELEASE / "candidate"),
                   "DELIVERY_ENHANCEMENTS_ARTIFACT": str(OUT), "DELIVERY_ENHANCEMENTS_SKIP_DB": "1",
                   "DELIVERY_ENHANCEMENTS_PROJECT": "mbbs-sidebar-preferences-gear-release-final"}
    with (RELEASE / "validation.log").open("wb") as log:
        result = subprocess.run(["bash", str(SERVER / "tools/delivery-request-enhancements-test.sh"),
                                 "node", "tools/app-sidebar-preferences-gear-checks.mjs"],
                                cwd=SERVER.parent, env=environment, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, "Exact sidebar candidate verification failed; see validation.log"
    assert (OUT / "teardown.log").read_text().endswith("teardown_exit=0\n")
    output = (RELEASE / "validation.log").read_text()
    assert "# tests 21\n" in output and "# pass 21\n" in output and "# fail 0\n" in output and "# skipped 0\n" in output
    tested = json.loads((OUT / "results/runtime-hashes.json").read_text())
    assert tested[FILES[0]] == data["workspace"][FILES[0]]
    core.current(data)
    core.save("validation-passed.json", {"passed": True, "at": core.now(),
              "candidateTreeHash": data["candidateTreeHash"], "tests": 21, "passedTests": 21, "skippedTests": 0})
    print(json.dumps({"validated": True, "passedTests": 21}), flush=True)


def verify():
    data = core.state()
    core.ready(data["candidateImageId"])
    live = core.metadata(core.APP)
    assert live["imageId"] == data["candidateImageId"] and live["configuration"] == data["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    actual = json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT))
    assert actual == data["candidateTree"], "Live runtime differs from the tested sidebar candidate"
    http = core.http_check({name: actual[name] for name in FILES}, ["/api/sales/delivery-requests/meta", "/api/dispatch/delivery-requests/meta"])
    core.save("deployment-result.json", {"deployed": True, "at": core.now(), "image": IMAGE,
              "imageId": live["imageId"], "candidateTreeHash": data["candidateTreeHash"], "changedFiles": FILES,
              "runtimeFilesVerified": len(actual), "configurationPreserved": True,
              "workerAndDependenciesUnchanged": True, "schemaChanged": False, "http": http})
    print(json.dumps({"deployed": True, "image": IMAGE, "http": http}), flush=True)


def apply_when_idle():
    history = RELEASE / "idle-check-attempts"
    history.mkdir(exist_ok=True)
    deadline = time.monotonic() + 90
    for attempt in range(1, 31):
        try:
            base.apply()
            return
        except AssertionError as error:
            prefix = "Wait for active business operations: "
            if not str(error).startswith(prefix) or time.monotonic() >= deadline:
                raise
            shutil.copy2(RELEASE / "active-before-release.json", history / f"{attempt}.json")
            print(json.dumps({"deferredAttempt": attempt, "activity": json.loads(str(error)[len(prefix):])}), flush=True)
            time.sleep(2 + attempt % 3)
    raise RuntimeError("Deployment could not obtain an idle business checkpoint")


base.verify = verify
if __name__ == "__main__":
    atexit.register(core.cleanup_manual)
    {"capture": base.capture, "rebase": base.rebase, "validate": validate,
     "build": core.build, "apply": apply_when_idle, "verify": verify}[sys.argv[1]]()
