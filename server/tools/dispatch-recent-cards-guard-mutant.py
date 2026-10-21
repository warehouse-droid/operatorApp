#!/usr/bin/env python3
"""Prove the recent-card completion regression rejects a disabled TO guard.

Runs only in the existing disposable database runner. The candidate is read,
copied to a temporary source tree, and verified unchanged after the mutation.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid


SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / "test-artifacts/dispatch-recent-cards"
FILES = [
    "src/dispatch-repository.js", "src/dispatch-order-recency.js",
    "src/dispatch-order-catalog-repository.js", "src/dispatch-planner-optimization.js",
    "src/dispatch-delivery-group-repository.js", "src/server.js",
    "migrations/242_dispatch_order_first_seen.sql"
]
POLICY = "src/dispatch-fulfilled-to-policy.js"
ORIGINAL = "const locallyCompleted = driverCompleted || row.operationally_completed === true;"
MUTANT = "const locallyCompleted = false;"


def hashes(source):
    return {filename: hashlib.sha256((source / filename).read_bytes()).hexdigest()
            for filename in FILES + [POLICY]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=OUT / "candidate")
    args = parser.parse_args()
    source = args.source_root.resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    artifacts = OUT / "guard-mutant"
    artifacts.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="guard-mutant-source-", dir=OUT))
    report = {"passed": False, "mutationKilled": False, "productionAccess": False,
              "sourceRoot": str(source), "sourceHashesUnchanged": False,
              "testPattern": "Driver and manually completed", "temporarySourceRemoved": False}
    before = hashes(source)
    report["beforeHashes"] = before
    try:
        shutil.copytree(source / "src", stage / "src")
        for directory in ["public", "test", "migrations", "tools", "contracts"]:
            target = source / directory
            if target.exists():
                (stage / directory).symlink_to(target.resolve(), target_is_directory=True)
        for file in source.iterdir():
            if file.is_file() and (file.suffix in [".json", ".js", ".mjs"] or file.name.startswith("Dockerfile")):
                (stage / file.name).symlink_to(file.resolve())
        policy = stage / POLICY
        text = policy.read_text()
        assert text.count(ORIGINAL) == 1, "The source completion guard differs from the reviewed mutation target."
        policy.write_text(text.replace(ORIGINAL, MUTANT, 1))
        report["mutatedPolicySha256"] = hashlib.sha256(policy.read_bytes()).hexdigest()
        check = "dispatch-recent-cards-guard-mutant-" + uuid.uuid4().hex[:8]
        command = [
            "sudo", "-n", "env", "BIN_PLANNING_CHECK=" + check,
            "BIN_PLANNING_SOURCE_ROOT=" + str(stage),
            "bash", str(SERVER / "tools/bin-planning-test.sh"),
            "node", "--test", "--test-concurrency=1",
            "--test-name-pattern=Driver and manually completed",
            "test/dispatch/integration/dispatch-recent-cards.test.js"
        ]
        report["command"] = command
        report["databaseArtifacts"] = str(SERVER / "test-artifacts/mbt-bin-planning/checks" / check)
        completed = subprocess.run(command, cwd=SERVER, text=True, capture_output=True)
        output = completed.stdout + completed.stderr
        (artifacts / "test.log").write_text(output)
        report["exitCode"] = completed.returncode
        report["mutationKilled"] = (
            completed.returncode != 0
            and "recent-card eligibility continues to exclude Driver and manually completed transfer deliveries" in output
            and "failureType: 'testCodeFailure'" in output
            and "Actual physical completion must continue to exclude orders from browse." in output
        )
        assert report["mutationKilled"], "The mutation must fail the completion assertion, not test collection or infrastructure."
        report["passed"] = True
    except Exception as error:
        report["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        after = hashes(source)
        report["afterHashes"] = after
        report["sourceHashesUnchanged"] = before == after
        shutil.rmtree(stage)
        report["temporarySourceRemoved"] = not stage.exists()
        report["passed"] = report["passed"] and report["sourceHashesUnchanged"]
        (artifacts / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: report[key] for key in ["passed", "mutationKilled", "sourceHashesUnchanged",
              "temporarySourceRemoved", "productionAccess"]} | {"artifacts": str(artifacts)}), flush=True)
        assert report["sourceHashesUnchanged"], "The source candidate changed during the isolated guard mutation."


if __name__ == "__main__":
    main()
