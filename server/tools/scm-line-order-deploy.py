"""Release the validated line-order patch over the live app with a short cutover."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / "deployments/scm-line-order-20260930"
EVIDENCE = SERVER / "test-artifacts/scm-line-order/final"
SNAPSHOT = EVIDENCE / "source-snapshot"
BASELINE = SERVER / "test-artifacts/scm-line-order/baseline"
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1", "mbbs-operator-app-webhook-worker-1"]
IMAGE = "mbbs-operator-app:scm-line-order-20260930"
MIGRATION = "244_smart_scm_line_order.sql"
FILES = [row["file"] for row in json.loads((EVIDENCE / "source-coverage.json").read_text())["results"]]
spec = importlib.util.spec_from_file_location("existing_release", SERVER / "tools/regular-stock-v2-deploy.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, {"app": APP}, DEPENDENCIES
docker, digest, metadata = release.docker, release.digest, release.metadata
HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
 if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def state():
    return json.loads((RELEASE / "manifest.json").read_text())


def current(data):
    assert metadata(APP) == data["services"]["app"]["before"], "Live app changed: recapture before cutover"
    assert {name: metadata(name) for name in DEPENDENCIES} == data["dependencies"], "A dependency changed"
    assert release.files_at(RELEASE / "candidate") == data["candidateTree"], "Candidate source changed"
    assert json.loads(docker("exec", APP, "node", "-e", HASH_SCRIPT)) == data["beforeTree"], "Live source changed"


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    prior_evidence = json.loads((EVIDENCE / "source-coverage.json").read_text())
    assert all(digest((SNAPSHOT / row["file"]).read_bytes()) == row["sha256"] for row in prior_evidence["results"])
    before = metadata(APP)
    data = {"services": {"app": {"before": before, "image": IMAGE}},
            "dependencies": {name: metadata(name) for name in DEPENDENCIES},
            "originalEvidenceSourceHash": prior_evidence["sourceHash"]}
    baseline = RELEASE / "before"
    baseline.mkdir()
    for folder in ["src", "public", "migrations"]:
        with tarfile.open(fileobj=io.BytesIO(docker("cp", APP + ":/app/" + folder, "-"))) as archive:
            archive.extractall(baseline, filter="data")
    for file in ["package.json", "package-lock.json"]:
        (baseline / file).write_bytes(docker("exec", APP, "cat", "/app/" + file))
    assert metadata(APP) == before, "App changed during capture"
    candidate = RELEASE / "candidate"
    shutil.copytree(baseline, candidate)
    patch = ""
    for file in FILES:
        original = (BASELINE / file).read_text() if (BASELINE / file).exists() else ""
        updated = (SNAPSHOT / file).read_text()
        patch += "".join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                              fromfile="a/" + file, tofile="b/" + file, n=3))
    (RELEASE / "release.patch").write_text(patch)
    result = subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-d", str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / "patch.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 0, "Scoped patch needs review; see patch.log"
    for path in candidate.rglob("*.orig"):
        path.unlink()
    data["beforeTree"], data["candidateTree"] = release.files_at(baseline), release.files_at(candidate)
    changed = sorted(file for file in data["beforeTree"].keys() | data["candidateTree"].keys()
                     if data["beforeTree"].get(file) != data["candidateTree"].get(file))
    assert changed == sorted(FILES), "Unexpected changed files: " + json.dumps(changed)
    data["sourceHashes"] = {file: data["candidateTree"][file] for file in FILES}
    current(data)
    save("manifest.json", data)
    print(json.dumps({"captured": True, "files": changed, "baseImage": before["image"]}), flush=True)


def prepare():
    data = state()
    current(data)
    candidate = RELEASE / "candidate"
    validation = RELEASE / "validation"
    if not validation.exists():
        shutil.copytree(candidate, validation)
        for folder in ["test", "tools"]:
            shutil.copytree(SERVER / folder, validation / folder, ignore=shutil.ignore_patterns("__pycache__"))
        for file in ["eslint.mbt.config.js", ".c8rc.json"]:
            shutil.copy2(SERVER / file, validation / file)
        # These existing test harnesses need the new scripts in their VM loaders.
        # They are test scaffolding and are not included in the release overlay.
        for file in ["src/smart-scm-vendor-ui-harness.js", "src/smart-scm-calculation-ui-harness.js", "src/smart-scm-vendor-workflow-harness.js"]:
            shutil.copy2(SERVER / file, validation / file)
        before = validation / "test-artifacts/scm-line-order/baseline"
        for file in FILES:
            if not (RELEASE / "before" / file).exists():
                continue
            (before / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / "before" / file, before / file)
    with (RELEASE / "candidate-validation.log").open("wb") as log:
        subprocess.run(["bash", "tools/scm-line-order-check.sh"], cwd=validation,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    checks = json.loads((validation / "test-artifacts/scm-line-order/final/summary.json").read_text())
    assert checks["nodeFailed"] == 0 and checks["nodeTests"] >= 133 and checks["browserChecks"] == 8
    save("candidate-checks.json", checks)
    print(json.dumps({"candidateValidated": checks}), flush=True)
    stage = RELEASE / "stage"
    for file in FILES:
        target = stage / "overlay" / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, target)
    base_tag = IMAGE + "-base"
    docker("tag", data["services"]["app"]["before"]["imageId"], base_tag)
    (stage / "Dockerfile").write_text("FROM " + base_tag + "\nCOPY --chown=node:node overlay/ /app/\n")
    with (RELEASE / "build.log").open("wb") as log:
        subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    data["services"]["app"]["candidateImageId"] = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    assert json.loads(docker("run", "--rm", "--network", "none", "--entrypoint", "node", IMAGE, "-e", HASH_SCRIPT)) == data["candidateTree"]
    docker("run", "--rm", "--network", "none", "-e", "MBBS_ENV_FILE=/nonexistent",
           "-e", "NETSUITE_DIRECT_ACCESS_ENABLED=false", "-e", "NETSUITE_MIRROR_ROLE=disabled",
           "--entrypoint", "node", IMAGE, "--input-type=module", "-e", "await import('./src/server.js');process.exit(0)")
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + data["services"]["app"]["before"]["imageId"] + "\n")
    release.config_check(data)
    current(data)
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "image": IMAGE, "files": len(FILES)}), flush=True)


def verify():
    data = state()
    release.core.ready(data["services"]["app"]["candidateImageId"])
    after = metadata(APP)
    assert after["imageId"] == data["services"]["app"]["candidateImageId"]
    assert after["configuration"] == data["services"]["app"]["before"]["configuration"]
    assert {name: metadata(name) for name in DEPENDENCIES} == data["dependencies"]
    assert json.loads(docker("exec", APP, "node", "-e", HASH_SCRIPT)) == data["candidateTree"]
    schema = json.loads(release.database("""SELECT json_build_object(
      'migration',(SELECT count(*) FROM schema_migrations WHERE filename='244_smart_scm_line_order.sql'),
      'column',(SELECT count(*) FROM information_schema.columns WHERE table_name='scm_smart_proposals' AND column_name='line_order' AND data_type='jsonb'),
      'invalidOrders',(SELECT count(*) FROM scm_smart_proposals WHERE jsonb_typeof(line_order) <> 'array' OR line_order IS NULL))"""))
    assert schema == {"migration": 1, "column": 1, "invalidOrders": 0}, schema
    public = {}
    for origin in ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"]:
        request = urllib.request.Request(origin + "/health", headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200 and json.loads(response.read())["ok"] is True
            public[origin] = 200
    for file, sha in data["sourceHashes"].items():
        if not file.startswith("public/"):
            continue
        path = "/scm/smart" if file.endswith(".html") else "/" + file.removeprefix("public/")
        request = urllib.request.Request("https://test.mbbsoperation.com" + path,
                                        headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read()
            assert response.status == 200
        if file.endswith(".html"):
            body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b"", body)
        assert digest(body) == sha, "Public asset differs: " + file
        public[path] = 200
    script = """import assert from 'node:assert/strict';
import {smartScmOrderedLines} from './src/smart-scm-line-order.js';
import {projectSmartScmCreatedPo} from './src/smart-scm-created-po.js';
const rows=[{line_id:9,item_id:101,item_name:'A',raw:{line_sequence_number:1}},
 {line_id:1,item_id:103,item_name:'C',raw:{line_sequence_number:4}},
 {line_id:2,item_id:1784,item_name:'PALLET',raw:{line_sequence_number:3}},
 {line_id:8,item_id:102,item_name:'B',raw:{line_sequence_number:2}}]
 .map(row=>({...row,location_id:1,quantity:6,unit:'EACH',rate:5,amount:30}));
const po=projectSmartScmCreatedPo({lines:[],physicalPalletLines:[]},{header:{},lines:rows});
assert.deepEqual(smartScmOrderedLines([...po.lines,...po.physicalPalletLines],po.lineOrder).map(line=>line.itemName),['A','B','PALLET','C']);
const response=await fetch('http://127.0.0.1:3000/api/scm/smart/proposals/0/line-order',{
 method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({lineOrder:[]})});
assert.equal(response.status,401);console.log(JSON.stringify({palletThird:true,anonymousReorderStatus:401}));"""
    smoke = json.loads(docker("exec", "-i", APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": IMAGE, "imageId": after["imageId"], "files": FILES,
              "configurationPreserved": True, "workerAndDependenciesUnchanged": True,
              "schema": schema, "healthAndAssets": public, "smoke": smoke}
    save("result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    checks = json.loads((RELEASE / "candidate-checks.json").read_text())
    assert checks["nodeFailed"] == 0 and checks["covered"] == checks["measured"]
    release.config_check(data)
    active = json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save("active-before-release.json", active)
    assert not any(active.values()), "Wait for active work: " + json.dumps(active)
    current(data)
    sql = (RELEASE / "candidate/migrations" / MIGRATION).read_text()
    started = time.monotonic()
    output = release.database("BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='20s';\n" + sql +
                              "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "') ON CONFLICT DO NOTHING;\nCOMMIT;")
    (RELEASE / "migration.log").write_text(output + "\n")
    save("migration-result.json", {"filename": MIGRATION, "seconds": round(time.monotonic() - started, 3), "oldAppOnline": True})
    current(data)
    stop_probe = threading.Event()
    samples = []
    def probe():
        while not stop_probe.is_set():
            stamp = time.monotonic()
            try:
                with urllib.request.urlopen("http://127.0.0.1:3000/health", timeout=0.5) as response:
                    ok = response.status == 200 and json.loads(response.read())["ok"] is True
            except Exception:
                ok = False
            samples.append({"seconds": round(stamp - cutover_start, 3), "ok": ok})
            stop_probe.wait(0.2)
    cutover_start = time.monotonic()
    watcher = threading.Thread(target=probe, daemon=True)
    watcher.start()
    try:
        with (RELEASE / "publish.log").open("wb") as log:
            subprocess.run(release.compose(data) + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / "rollback.log").open("wb") as log:
            subprocess.run(release.compose(data, "compose.rollback.yml") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(data["services"]["app"]["before"]["imageId"])
        save("rollback-result.json", {"rolledBack": True, "additiveMigrationRetained": True})
        raise
    finally:
        stop_probe.set()
        watcher.join(timeout=2)
        failures = [sample["seconds"] for sample in samples if not sample["ok"]]
        recovered = [sample["seconds"] for sample in samples if sample["ok"] and failures and sample["seconds"] > max(failures)]
        interruption = round(min(recovered) - min(failures), 3) if recovered else None
        save("cutover.json", {"totalSeconds": round(time.monotonic() - cutover_start, 3),
                              "observedInterruptionSeconds": interruption, "samples": samples})
    print(json.dumps({"cutover": json.loads((RELEASE / "cutover.json").read_text()) | {"samples": len(samples)}}), flush=True)


if __name__ == "__main__":
    {"capture": capture, "prepare": prepare, "apply": apply, "verify": verify}[sys.argv[1]]()
