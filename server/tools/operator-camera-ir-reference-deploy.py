"""Deploy automatic camera entry and IR Ref No after regression verification."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("pagination_deploy", Path(__file__).with_name("consolidation-pagination-deploy.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
deployment.core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-camera-ir-reference-20260916")
deployment.core.BASE_IMAGE = "sha256:bda008499b453613391ea97f7e1f44f32c73364cab09a417b378f3a432fe4d13"
deployment.core.IMAGE = "mbbs-operator-app:operator-camera-ir-reference-20260916-v1"
deployment.core.ROLLBACK = "mbbs-operator-app:rollback-camera-ir-reference-app-20260916"
deployment.BASE_WORKER_IMAGE = "sha256:0ce822ac692745f914776588ecd77f58f5798cbe9047e9dc1b2694f4ad1102fb"
deployment.WORKER_ROLLBACK = "mbbs-operator-app:rollback-camera-ir-reference-worker-20260916"
deployment.UPDATE_WORKER = True
deployment.VERIFY_WORKSPACE_RUNTIME = True
deployment.core.SERVICES = ["mbbs-operator-app-app-1", "mbbs-operator-app-webhook-worker-1"]
deployment.core.DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
deployment.core.FILES = sorted([*deployment.core.FILES, "src/operator-netsuite-posting-domain.js"])
deployment.SOURCE_MANIFEST = deployment.core.SERVER / "test-artifacts/ir-po-reference/release-changes.json"
deployment.VERSION = "20260916-operator-auto-camera-v1"
deployment.UNIT_TESTS += ["test/mbt/unit/sales-order-reload-photo-entry.test.js",
    "test/mbt/unit/ir-po-reference.test.js", "test/mbt/unit/sn1400333-receiving.test.js"]
deployment.BROWSER_TESTS.append("test/dispatch/frontend/operator-auto-camera.browser.test.mjs")
deployment.EXPECTED_UNIT_PASSES = 39
deployment.EXPECTED_BROWSER_PASSES = 11


def regression_gate():
    folder = deployment.core.SERVER / "test-artifacts/ir-po-reference"
    subprocess.run(["python3", "tools/ir-po-reference-evidence.py"], cwd=deployment.core.SERVER, check=True, stdout=subprocess.DEVNULL)
    summary = json.loads((folder / "summary.json").read_text())
    for file, digest in summary["sources"].items():
        assert hashlib.sha256((deployment.core.SERVER / file).read_bytes()).hexdigest() == digest, f"Untested change: {file}"
    assert summary["newTypeErrors"] == 0 and summary["mutationKills"] == summary["propertyMutationKills"] == 4
    assert all(row["count"] > 0 for row in summary["changed"])
    static = json.loads((deployment.core.SERVER / "test-artifacts/operator-auto-camera/static.json").read_text())
    assert all(row["newDiagnostics"] == 0 for row in static)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    if mode == "prepare":
        deployment.prepare()
    elif mode == "apply":
        regression_gate()
        deployment.apply()
    else:
        print(json.dumps(deployment.verify()))
