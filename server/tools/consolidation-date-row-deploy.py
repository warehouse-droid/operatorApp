"""Deploy the compact date-control layout using the verified UI deployment flow."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("pagination_deploy", Path(__file__).with_name("consolidation-pagination-deploy.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
deployment.core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/consolidation-date-row-20260916")
deployment.core.BASE_IMAGE = "sha256:328d6f4252c46f1e79cedbd232717c0e3515d8111926f94b4d8d3ddca5364100"
deployment.core.IMAGE = "mbbs-operator-app:consolidation-date-row-20260916-v1"
deployment.core.ROLLBACK = "mbbs-operator-app:rollback-consolidation-date-row-20260916"
deployment.BASE_WORKER_IMAGE = "sha256:0ce822ac692745f914776588ecd77f58f5798cbe9047e9dc1b2694f4ad1102fb"
deployment.SOURCE_MANIFEST = deployment.core.SERVER / "test-artifacts/consolidation-date-row/changes.json"
deployment.VERSION = "20260916-consolidation-date-row-v1"

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    if mode == "prepare":
        deployment.prepare()
    elif mode == "apply":
        deployment.apply()
    else:
        print(json.dumps(deployment.verify()))
