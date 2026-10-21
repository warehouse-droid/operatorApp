"""Overlay only the tested return mapping files on the exact live images."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
ARTIFACT = SERVER / "test-artifacts/return-stored-orderline"
RELEASE = Path(os.environ.get("RETURN_STORED_RELEASE_ROOT", "/home/ubuntu/operatorapp-deploy-backups/return-stored-orderline-20260930-v2"))
SERVICES = {"app": "mbbs-operator-app-app-1", "webhook-worker": "mbbs-operator-app-webhook-worker-1"}
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
FILES = ["src/return-netsuite.js", "src/return-stored-orderline.js"]
spec = importlib.util.spec_from_file_location("release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, digest, metadata, files_at = core.docker, core.digest, core.metadata, core.files_at


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + "\n")


def state():
    return json.loads((RELEASE / "manifest.json").read_text())


def hashes():
    return {file: digest((SERVER / file).read_bytes()) for file in FILES}


def current(data):
    assert hashes() == data["workspace"], "Return mapping source changed."
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"], "Dependency containers changed."
    for service, row in data["services"].items():
        assert metadata(SERVICES[service]) == row["before"], "Live " + service + " changed; rebase before release."
        assert files_at(RELEASE / ("candidate-" + service)) == row["tree"], "Candidate source changed."


def compose(data, override):
    args = ["sudo", "-n", "docker", "compose", "-p", "mbbs-operator-app"]
    for file in data["services"]["app"]["before"]["configFiles"].split(","):
        args.extend(["-f", file])
    return args + ["-f", str(RELEASE / override)]


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    data = {"workspace": hashes(), "dependencies": [metadata(name) for name in DEPENDENCIES], "services": {}}
    for service, container in SERVICES.items():
        before = metadata(container)
        baseline = RELEASE / ("baseline-" + service)
        baseline.mkdir()
        for folder in ["src", "public", "migrations"]:
            docker("cp", container + ":/app/" + folder, str(baseline / folder))
        for file in ["package.json", "package-lock.json"]:
            docker("cp", container + ":/app/" + file, str(baseline / file))
        subprocess.run(["sudo", "-n", "chown", "-R", str(os.getuid()) + ":" + str(os.getgid()), str(baseline)], check=True)
        assert metadata(container) == before, "Live container changed during capture."
        assert (baseline / FILES[0]).read_bytes() == (ARTIFACT / "workspace-before" / FILES[0]).read_bytes(), "Live caller differs from the tested baseline."
        assert not (baseline / FILES[1]).exists(), "Stored return mapper already deployed."
        for file in ["src/netsuite-order-line.js", "src/operator-netsuite-posting-stored-lines.js"]:
            assert (baseline / file).read_bytes() == (SERVER / file).read_bytes(), "Mapping dependency differs: " + file
        candidate = RELEASE / ("candidate-" + service)
        shutil.copytree(baseline, candidate)
        for file in FILES:
            shutil.copy2(SERVER / file, candidate / file)
        old, new = files_at(baseline), files_at(candidate)
        assert sorted(file for file in new if new[file] != old.get(file)) == FILES, "Unexpected release scope."
        assert not set(old) - set(new), "Release removed files."
        image = "mbbs-operator-app:" + RELEASE.name + "-" + service
        stage = RELEASE / ("stage-" + service)
        for file in FILES:
            (stage / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / file, stage / file)
        base_tag = "mbbs-operator-app:rollback-" + RELEASE.name + "-" + service
        (stage / "Dockerfile").write_text("FROM " + base_tag + "\n" +
            "".join("COPY " + file + " /app/" + file + "\n" for file in FILES))
        data["services"][service] = {"before": before, "image": image, "baseTag": base_tag, "tree": new, "changedFiles": FILES}
    # Test support is outside the runtime tree and never copied into the images.
    candidate = RELEASE / "candidate-app"
    for folder in ["test", "tools", "contracts"]:
        (candidate / folder).symlink_to(SERVER / folder, target_is_directory=True)
    for file in ["tsconfig.mbt.json", "eslint.mbt.config.js"]:
        (candidate / file).symlink_to(SERVER / file)
    for name, key in [("compose.release.yml", "image"), ("compose.rollback.yml", "before")]:
        content = "services:\n"
        for service, row in data["services"].items():
            value = row["image"] if key == "image" else row["before"]["imageId"]
            content += "  " + service + ":\n    image: " + value + "\n"
        (RELEASE / name).write_text(content)
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "services": list(SERVICES), "changedFiles": FILES}), flush=True)


def tree_in_container(container):
    script = """import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const result={};function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);
if(item.isDirectory())walk(file);else if(item.isFile())result[file.replace(/^\\/app\\//,'')]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
for(const folder of ['src','public','migrations'])walk('/app/'+folder);console.log(JSON.stringify(result));"""
    return json.loads(docker("exec", "-i", container, "node", "--input-type=module", input=script.encode()))


def build():
    data = state()
    current(data)
    for service, row in data["services"].items():
        docker("tag", row["before"]["imageId"], row["baseTag"])
        assert docker("image", "inspect", "--format", "{{.Id}}", row["baseTag"]).decode().strip() == row["before"]["imageId"]
        with (RELEASE / ("build-" + service + ".log")).open("wb") as output:
            subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", row["image"],
                            str(RELEASE / ("stage-" + service))], stdout=output, stderr=subprocess.STDOUT, check=True)
        row["candidateImageId"] = docker("image", "inspect", "--format", "{{.Id}}", row["image"]).decode().strip()
        temporary = docker("create", "--network", "none", "--entrypoint", "sleep", row["image"], "120").decode().strip()
        try:
            docker("start", temporary)
            assert tree_in_container(temporary) == row["tree"], "Built image contains unexpected runtime files."
        finally:
            docker("rm", "-f", temporary)
    save("manifest.json", data)
    print(json.dumps({"built": True, "runtimeTreesVerified": {key: len(row["tree"]) for key, row in data["services"].items()}}), flush=True)


def candidate_probe():
    data = state()
    current(data)
    config_check(data)
    inspected = json.loads(docker("inspect", SERVICES["app"]))[0]
    networks = list(inspected["NetworkSettings"]["Networks"])
    assert len(networks) == 1, "Choose the live application network explicitly."
    # Reuse the exact runtime environment privately; never log credentials.
    with tempfile.TemporaryDirectory(prefix="return-stored-live-", dir=RELEASE) as directory:
        environment = Path(directory) / "environment"
        environment.write_text("\n".join(inspected["Config"]["Env"]) + "\n")
        environment.chmod(0o600)
        result = json.loads(docker("run", "--rm", "--network", networks[0], "--env-file", str(environment),
            "--volumes-from", SERVICES["app"] + ":ro", "-i", "--entrypoint", "node",
            data["services"]["app"]["candidateImageId"], "--input-type=module",
            input=(SERVER / "tools/return-stored-orderline-live.mjs").read_bytes()))
    save("candidate-live-probe.json", {"images": {key: row["candidateImageId"] for key, row in data["services"].items()}, **result})
    print(json.dumps(result), flush=True)


def candidate_tests():
    data = state()
    current(data)
    files = ["unit/return-stored-orderline", "integration/return-stored-orderline",
        "unit/return-batch-ra-domain", "unit/return-ra-workflow", "unit/return-ra-client",
        "integration/return-batch-ra", "integration/return-ra-workflow", "integration/stock-return-draft-insert",
        "integration/netsuite-order-line-storage", "integration/operator-direct-orderline"]
    environment = dict(os.environ, RETURN_STORED_SOURCE_ROOT=str(RELEASE / "candidate-app"),
        RETURN_STORED_TEST_SUBNET="10.254.69.0/24")
    with (RELEASE / "candidate-tests.log").open("wb") as output:
        completed = subprocess.run(["bash", str(SERVER / "tools/return-stored-orderline-isolated.sh"),
            "node", "--test", "--test-concurrency=1", "--test-timeout=120000",
            *["test/mbt/" + file + ".test.js" for file in files]], env=environment, cwd=ROOT,
            stdout=output, stderr=subprocess.STDOUT, timeout=300)
    assert completed.returncode == 0, "Candidate regression tests failed; see candidate-tests.log."
    output = (RELEASE / "candidate-tests.log").read_text()
    counts = {key: int(re.search(r"^# " + key + r" (\d+)$", output, re.M)[1]) for key in ["tests", "pass", "fail", "skipped"]}
    assert counts["tests"] == counts["pass"] == 99 and counts["fail"] == counts["skipped"] == 0, counts
    result = {"passed": True, "sourceHashes": data["workspace"], "counts": counts,
        "testedSource": "captured live application with only the two return mapping files overlaid"}
    save("candidate-tests.json", result)
    print(json.dumps(result), flush=True)


def config_check(data):
    resolved = json.loads(subprocess.check_output(compose(data, "compose.release.yml") + ["config", "--format", "json"], cwd=ROOT))["services"]
    for service, row in data["services"].items():
        image = json.loads(docker("image", "inspect", row["candidateImageId"]))[0]["Config"]
        running = json.loads(docker("inspect", SERVICES[service]))[0]["Config"]
        service_config = resolved[service]
        environment = dict(entry.split("=", 1) for entry in image["Env"])
        environment.update({key: str(value) for key, value in service_config.get("environment", {}).items()})
        assert environment == dict(entry.split("=", 1) for entry in running["Env"]), "Compose would change the " + service + " environment."
        for field, key in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("User", "user"), ("WorkingDir", "working_dir")]:
            value = service_config.get(key)
            assert (image.get(field) if value is None else value) == running.get(field), "Compose would change " + field


def ready(data, rollback=False):
    for _ in range(60):
        ok = True
        for service, row in data["services"].items():
            running = json.loads(docker("inspect", SERVICES[service]))[0]
            image_id = row["before"]["imageId"] if rollback else row["candidateImageId"]
            ok = ok and running["Image"] == image_id and running["State"]["Running"] and running["RestartCount"] == 0
        if ok:
            probe = "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"
            result = subprocess.run(["sudo", "-n", "docker", "exec", SERVICES["app"], "node", "-e", probe], capture_output=True)
            if result.returncode == 0:
                return
        time.sleep(0.5)
    raise RuntimeError("Application and webhook worker did not become ready.")


def verify():
    data = state()
    ready(data)
    for service, row in data["services"].items():
        assert metadata(SERVICES[service])["configuration"] == row["before"]["configuration"], "Runtime configuration changed."
        assert tree_in_container(SERVICES[service]) == row["tree"], "Deployed source tree differs."
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"], "Database or Ollama container changed."
    http = """import assert from 'node:assert/strict';for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
const response=await fetch(base+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
for(const [path,method] of [['/api/returns/reasons','GET'],['/api/returns/orders/lookup','POST'],['/api/returns/submit','POST']]){
const result=await fetch(base+path,{method});assert.equal(result.status,401,path);}}
console.log(JSON.stringify({localHealth:200,publicHealth:200,anonymousReturnRequests:401,protectedEndpointChecks:6}));"""
    health = json.loads(docker("exec", "-i", SERVICES["app"], "node", "--input-type=module", input=http.encode()))
    live = json.loads(docker("exec", "-i", SERVICES["app"], "node", "--input-type=module",
        input=(SERVER / "tools/return-stored-orderline-live.mjs").read_bytes()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "images": {key: row["candidateImageId"] for key, row in data["services"].items()},
        "configurationPreserved": True, "completeRuntimeTreesVerified": True, "changedFiles": FILES, **health, **live}
    save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    evidence = json.loads((ARTIFACT / "evidence.json").read_text())
    assert evidence["passed"] and evidence["sourceHashes"] == data["workspace"], "Fresh verification is required."
    probe = json.loads((RELEASE / "candidate-live-probe.json").read_text())
    assert probe["passed"] and probe["images"] == {key: row["candidateImageId"] for key, row in data["services"].items()}
    checks = json.loads((RELEASE / "candidate-tests.json").read_text())
    assert checks["passed"] and checks["sourceHashes"] == data["workspace"], "Candidate regression checks are required."
    config_check(data)
    for row in data["services"].values():
        assert docker("image", "inspect", "--format", "{{.Id}}", row["image"]).decode().strip() == row["candidateImageId"]
    active = core.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'),
      'returnPosting',(SELECT count(*) FROM return_batch_authorizations WHERE sync_status='pending' AND attempted_at>now()-interval '5 minutes'));""")
    active = json.loads(active)
    save("active-before-release.json", active)
    assert not any(active.values()), "Wait for active work: " + json.dumps(active)
    current(data)
    command = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", *SERVICES]
    print(json.dumps({"cutoverStarted": datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
    try:
        with (RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(compose(data, "compose.release.yml") + command, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(compose(data, "compose.rollback.yml") + command, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        ready(data, rollback=True)
        save("rolled-back.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "schemaAndDataUnchanged": True})
        raise


if __name__ == "__main__":
    {"prepare": prepare, "build": build, "candidate-probe": candidate_probe, "candidate-tests": candidate_tests,
     "apply": apply, "verify": verify}[sys.argv[1]]()
