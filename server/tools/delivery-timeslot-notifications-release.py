#!/usr/bin/env python3
"""Release the authorized, tested delivery/trip/notification overlay only."""
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
TASK = SERVER / "test-artifacts/delivery-timeslot-notifications-20261014"
OUT = TASK / "release-final"
RELEASE = SERVER / "deployments/delivery-timeslot-notifications-20261014"
IMAGE = "mbbs-operator-app:delivery-timeslot-notifications-20261014"

spec = importlib.util.spec_from_file_location("delivery_release", SERVER / "tools/delivery-scm-release.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
core.IMAGE = IMAGE
core.ROLLBACK = IMAGE + "-rollback"
core.READ_NAME = "mbbs-delivery-timeslot-notifications-release-reader"
core.CHECK_NAME = "mbbs-delivery-timeslot-notifications-release-import"
original_compose = core.compose


def compose(data, mode):
    # Existing release overrides include root-owned files. Preserve the
    # established privileged Compose invocation without changing their access.
    return original_compose(data, mode)


core.compose = compose


def tested_inputs():
    evidence = json.loads((TASK / "EVIDENCE.json").read_text())
    result = evidence["testResults"]
    assert result["passed"] == 226 and result["failed"] == 2 and result["knownBaselineFailures"]
    assert all(row["killed"] and row["restored"] for row in evidence["mutations"])
    for name, value in evidence["runtimeHashes"].items():
        assert core.sha((SERVER / name).read_bytes()) == value, "Tested input changed: " + name
    assert (TASK / "final/teardown.log").read_text().endswith("teardown_exit=0\n")
    return evidence["runtimeHashes"]


def capture(reuse=False):
    os.umask(0o077)
    inputs = tested_inputs()
    originals = json.loads((TASK / "before-hashes.json").read_text())
    before = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    if reuse:
        assert RELEASE.is_dir() and not (RELEASE / "manifest.json").exists()
    else:
        RELEASE.mkdir(parents=True, exist_ok=False)
    baseline = RELEASE / "before"
    baseline.mkdir()
    archive = core.docker("exec", core.APP, "tar", "-cf", "-", "-C", "/app",
                          "src", "public", "migrations", "package.json", "package-lock.json")
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter="data")
    assert core.metadata(core.APP) == before, "Live application changed during capture"
    candidate = RELEASE / "candidate"
    shutil.copytree(baseline, candidate)
    for name in inputs:
        old = baseline / name
        if name in originals:
            assert old.exists() and core.sha(old.read_bytes()) == originals[name], (
                "Overlapping production update requires merging: " + name
            )
        else:
            assert not old.exists(), "A new notification module already exists in production: " + name
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, after_tree = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys()
                     if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(inputs), "Release includes unexpected changes"
    # The isolated harness runs as the normal application user.
    for directory, directories, files in os.walk(RELEASE):
        os.chmod(directory, 0o755)
        for filename in files:
            os.chmod(Path(directory) / filename, 0o644)
    data = {
        "capturedAt": core.now(), "app": before, "dependencies": dependencies,
        "files": changed, "beforeTree": before_tree, "candidateTree": after_tree,
        "candidateTreeHash": core.sha(json.dumps(after_tree, sort_keys=True).encode()),
        "workspace": inputs,
        "packages": {name: core.sha((candidate / name).read_bytes())
                     for name in ("package.json", "package-lock.json")},
    }
    core.save("manifest.json", data)
    core.current(data)
    print(json.dumps({"captured": True, "changedFiles": changed,
                      "runtimeFilesPreserved": len(before_tree) - sum(name in before_tree for name in inputs)}), flush=True)


def rebase():
    data = core.state()
    before = core.metadata(core.APP)
    tree = json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT))
    changed = sorted(name for name in data["beforeTree"].keys() | tree.keys()
                     if data["beforeTree"].get(name) != tree.get(name))
    assert not set(changed) & set(data["files"]), "An overlapping update requires a scoped merge"
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    assert before["configuration"] == data["app"]["configuration"], "Application configuration changed"
    assert "candidateImageId" not in data, "A built release needs an explicit image rebuild"
    history = RELEASE / "attempts"
    history.mkdir(exist_ok=True)
    previous = history / str(len(list(history.iterdir())) + 1)
    previous.mkdir()
    for name in ("before", "candidate", "manifest.json", "validation-passed.json", "validation.log"):
        path = RELEASE / name
        if path.exists():
            path.rename(previous / name)
    if OUT.exists():
        OUT.rename(TASK / ("release-attempt-" + previous.name))
    # capture() still enforces the original hashes for every touched runtime
    # file. Unrelated newly deployed files become the preserved release base.
    capture(reuse=True)
    core.save("rebase-result.json", {"at": core.now(), "preservedNewLiveFiles": changed,
                                     "previousAttempt": str(previous)})


def validate():
    data = core.state()
    core.current(data)
    environment = {
        **os.environ,
        "DELIVERY_ENHANCEMENTS_SOURCE": str(RELEASE / "candidate"),
        "DELIVERY_ENHANCEMENTS_ARTIFACT": str(OUT),
        "DELIVERY_ENHANCEMENTS_PROJECT": "mbbs-delivery-timeslot-notifications-release-final",
    }
    command = [
        "bash", str(SERVER / "tools/delivery-request-enhancements-test.sh"),
        "node", "node_modules/c8/bin/c8.js", "--all=false",
        "--include=src/delivery-request-domain.js", "--include=src/delivery-request-repository.js",
        "--reporter=json", "--reporter=json-summary", "--reporter=text-summary",
        "--reports-dir=test-artifacts/coverage",
        "node", "tools/delivery-timeslot-notifications-checks.mjs", "final",
    ]
    with (RELEASE / "validation.log").open("wb") as log:
        result = subprocess.run(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, "Exact release candidate validation failed; see validation.log"
    assert (OUT / "teardown.log").read_text().endswith("teardown_exit=0\n"), "Test teardown failed"
    tests = json.loads((OUT / "results/test-results.json").read_text())
    assert tests["passed"] == 226 and tests["failed"] == 2 and tests["knownBaselineFailures"]
    mutants = json.loads((OUT / "results/mutations.json").read_text())
    assert len(mutants) == 8 and all(row["killed"] and row["restored"] for row in mutants)
    core.current(data)
    core.save("validation-passed.json", {
        "passed": True, "at": core.now(), "candidateTreeHash": data["candidateTreeHash"],
        "command": command, "testResults": tests, "mutantsKilled": len(mutants),
    })
    print(json.dumps({"validated": True, "testResults": tests, "mutantsKilled": len(mutants)}), flush=True)


def active_operations():
    result = json.loads(core.sql("""BEGIN READ ONLY; SET LOCAL statement_timeout='5s';
SELECT json_build_object(
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
 'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
 'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
 'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
 'openTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'));
COMMIT;"""))
    core.save("active-before-release.json", {"at": core.now(), **result})
    assert not any(result.values()), "Wait for active business operations: " + json.dumps(result)
    return result


def verify():
    data = core.state()
    core.ready(data["candidateImageId"])
    live = core.metadata(core.APP)
    assert live["imageId"] == data["candidateImageId"]
    assert live["configuration"] == data["app"]["configuration"], "Application configuration changed"
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"], "Another service changed"
    actual = json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT))
    assert actual == data["candidateTree"], "Live runtime differs from validated release"
    public = {name: data["candidateTree"][name] for name in data["files"] if name.startswith("public/")}
    http = core.http_check(public, ["/api/sales/delivery-requests/meta", "/api/dispatch/delivery-requests/meta"])
    script = """import assert from 'node:assert/strict';
const version='20261014-timeslot-trips-notifications';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for(const team of ['sales','dispatch']) {
  const page=await fetch(origin+'/'+team+'/delivery-requests',{signal:AbortSignal.timeout(15000)});
  assert.equal(page.status,200);assert.ok((await page.text()).includes(version));
 }
 for(const name of ['app-notifications.js','app-notification-worker.js']) {
  const response=await fetch(origin+'/'+name+'?v=20261014',{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/javascript/);
 }
}
console.log(JSON.stringify({assetVersion:version,notificationScriptsServed:true}));"""
    extra = json.loads(core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode(), timeout=90))
    core.save("deployment-result.json", {
        "deployed": True, "at": core.now(), "image": IMAGE, "imageId": live["imageId"],
        "candidateTreeHash": data["candidateTreeHash"], "changedFiles": data["files"],
        "runtimeFilesVerified": len(actual), "configurationPreserved": True,
        "workerAndDependenciesUnchanged": True, "schemaChanged": False,
        "http": http, **extra,
    })
    print(json.dumps({"deployed": True, "image": IMAGE, "http": http, **extra}), flush=True)


def apply():
    data = core.state()
    tested_inputs()
    core.current(data)
    check = json.loads((RELEASE / "image-check.json").read_text())
    validation = json.loads((RELEASE / "validation-passed.json").read_text())
    assert check["passed"] and check["imageId"] == data["candidateImageId"]
    assert validation["passed"] and validation["candidateTreeHash"] == data["candidateTreeHash"]
    assert core.docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip() == data["candidateImageId"]
    core.config_check(data)
    active_operations()
    leases = core.edit_lease_identities()
    core.current(data)
    arguments = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"]
    try:
        with (RELEASE / "publish.log").open("wb") as log:
            subprocess.run(compose(data, "release") + arguments, cwd=ROOT,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        after = core.edit_lease_identities()
        core.save("editing-lease-result.json", {"before": leases, "after": after,
                                                "retained": set(leases) <= set(after)})
    except BaseException:
        # Avoid replacing a third party's release if it changed concurrently.
        current_image = core.metadata(core.APP)["imageId"]
        if current_image in (data["candidateImageId"], data["app"]["imageId"]):
            with (RELEASE / "rollback.log").open("wb") as log:
                subprocess.run(compose(data, "rollback") + arguments, cwd=ROOT,
                               stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
            core.ready(data["app"]["imageId"])
            core.save("rollback-result.json", {"restoredImageId": data["app"]["imageId"], "at": core.now()})
        raise


if __name__ == "__main__":
    # Register before any phase can create a disposable image-check container.
    atexit.register(core.cleanup_manual)
    {"capture": capture, "rebase": rebase, "validate": validate, "build": core.build,
     "apply": apply, "verify": verify}[sys.argv[1]]()
