"""Deploy the tested direct-orderLine app and worker; retain the current IR fix."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request

spec = importlib.util.spec_from_file_location("operator_deploy", Path(__file__).with_name("operator-improvements-deploy.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-direct-orderline-20260916-v3")
core.BASE_IMAGE = "sha256:964fbe441b8030c3645e011e450aca6ebd943d163c38e3baa898821ce3c16010"
core.IMAGE = "mbbs-operator-app:operator-direct-orderline-20260916-v3"
core.ROLLBACK = "mbbs-operator-app:rollback-direct-orderline-20260916"
artifact = core.SERVER / "test-artifacts/operator-direct-orderline"
switch = "OPERATOR_NETSUITE_STORED_ORDER_LINE_POSTING"


def source_gate():
    changes = json.loads((artifact / "changes.json").read_text())
    runtime = [row for row in changes if row["file"].startswith(("src/", "public/"))]
    core.FILES = sorted(row["file"] for row in runtime)
    for row in runtime:
        assert hashlib.sha256((core.SERVER / row["file"]).read_bytes()).hexdigest() == row["afterSha256"], row["file"]
    return ({row["file"]: row["beforeSha256"] for row in runtime},
            {row["file"]: row["afterSha256"] for row in runtime})


def regression_gate():
    source_gate()
    checks = json.loads((artifact / "checks.json").read_text())
    static = json.loads((artifact / "static.json").read_text())
    assert checks["mutationKills"] == checks["propertyMutationKills"] == 7
    assert checks["changedLineCoverage"] == 1
    assert static["newTypeErrors"] == static["newLint"] == 0
    for result in [checks, static]:
        for file, digest in result["sources"].items():
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Untested source: {file}"
    logs = [(artifact / name).read_text() for name in ["baseline-full.log", "full-final.log"]]
    failures = [re.findall(r"^✖ (.+?) \([0-9.]+ms\)$", log, re.M) for log in logs]
    assert failures[0] == failures[1] == ["P3.12: browser specs share one worker-owned database-pool lifecycle"] * 2
    assert all("Isolated MBT main run failed in 1/" in log for log in logs)
    browser = json.loads((artifact / "browser.json").read_text())
    assert browser["sourceSha256"] == hashlib.sha256((core.SERVER / "public/operator.js").read_bytes()).hexdigest()
    assert browser["changedCoverage"]["missing"] == []


def environment(row):
    return dict(value.split("=", 1) for value in row["Config"]["Env"])


def config_gate(before, image_id):
    command = core.compose(before, "compose.release.yml")
    configured = json.loads(core.run(*command, "config", "--format", "json"))
    defaults = environment(core.inspect(image_id)[0])
    for prior, service in zip(before, ["app", "webhook-worker"]):
        actual = {**defaults, **{key: str(value) for key, value in configured["services"][service]["environment"].items()}}
        assert actual == {**environment(prior), switch: "true"}, f"Unexpected environment change: {service}"
    core.save("compose.release.private.json", configured)


def prepare():
    os.umask(0o077)
    expected_before, expected_after = source_gate()
    core.RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not (core.RELEASE / "manifest.json").exists(), "Release already prepared"
    before = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert all(row["Image"] == core.BASE_IMAGE for row in before[:2]), "Live release changed"
    for service in core.SERVICES:
        assert core.hashes(service) == expected_before, service
    core.save("containers.before.private.json", before)
    core.run("docker", "tag", core.BASE_IMAGE, core.ROLLBACK)
    (core.RELEASE / "compose.release.yml").write_text("services:\n" + "".join(
        f"  {service}:\n    image: {core.IMAGE}\n    environment:\n      {switch}: 'true'\n" for service in ["app", "webhook-worker"]))
    (core.RELEASE / "compose.rollback.yml").write_text("services:\n" + "".join(
        f"  {service}:\n    image: {core.ROLLBACK}\n" for service in ["app", "webhook-worker"]))
    stage = core.RELEASE / "image"
    for file in core.FILES:
        destination = stage / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(core.SERVER / file, destination)
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\n" + "\n".join(
        f"COPY --chown=node:node {file} /app/{file}" for file in core.FILES) + "\n")
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate.keys() if original.get(file) != candidate.get(file))
    assert changed == core.FILES
    for file, digest in candidate.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, file
    core.save("candidate-files.json", candidate)
    config_gate(before, image_id)
    core.candidate_smoke(image_id)
    flag = core.run("docker", "run", "--rm", "--network", "none", "-e", f"{switch}=true", "--entrypoint", "node", image_id,
                    "--input-type=module", "-e", "import {config} from './src/config.js';if(config.netsuite.operatorStoredOrderLinePosting!==true)process.exit(1);console.log('enabled')")
    assert flag.strip() == b"enabled"
    core.save("manifest.json", {"image": core.IMAGE, "imageId": image_id, "before": expected_before, "after": expected_after,
              "changedFiles": changed, "environmentChange": {switch: "true"}, "rollbackImage": core.ROLLBACK})
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "files": len(changed)}), flush=True)


def verify():
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    after = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    for prior, row in zip(before[:2], after[:2]):
        assert row["Image"] == manifest["imageId"] and row["State"]["Running"] and row["RestartCount"] == 0
        assert environment(row) == {**environment(prior), switch: "true"}
        assert sorted(prior["Mounts"], key=lambda mount: mount["Destination"]) == sorted(row["Mounts"], key=lambda mount: mount["Destination"])
        for key in ["Cmd", "Entrypoint", "User", "WorkingDir"]:
            assert prior["Config"][key] == row["Config"][key]
        assert prior["HostConfig"]["PortBindings"] == row["HostConfig"]["PortBindings"]
        assert core.hashes(row["Name"]) == manifest["after"]
    assert [(row["Id"], row["State"]["StartedAt"]) for row in before[2:]] == [(row["Id"], row["State"]["StartedAt"]) for row in after[2:]]
    with urllib.request.urlopen(urllib.request.Request("https://test.mbbsoperation.com/health", headers={"User-Agent": "Mozilla/5.0"}), timeout=15) as response:
        assert response.status == 200 and json.load(response)["ok"]
    runtime = core.node_read("""import assert from 'node:assert/strict';import {config} from './src/config.js';import {query,closeDb} from './src/db.js';
      import {createOperatorNetSuitePostingRealSourceResolver} from './src/operator-netsuite-posting-targets.js';
      try {
        const resolve=createOperatorNetSuitePostingRealSourceResolver({query,useStoredOrderLines:true,
          fetchLiveSource:async()=>{throw new Error('Unexpected live source read');}});
        const replays=[];
        for(const [header,lines,parent,type,functionKey,stage] of [
          ['sales_orders','sales_order_lines','sales_order_id','sales_order','customer_pickup',null],
          ['purchase_orders','purchase_order_lines','purchase_order_id','purchase_order','receiving',null],
          ['transfer_orders','transfer_order_lines','transfer_order_id','transfer_order','delivery_prep','outbound'],
          ['transfer_orders','transfer_order_lines','transfer_order_id','transfer_order','receiving','receiving']]){
          const candidate=(await query(`SELECT h.netsuite_id,h.tranid FROM ${header} h WHERE h.netsuite_id>0 AND h.netsuite_active=true
            AND EXISTS(SELECT 1 FROM ${lines} l WHERE l.${parent}=h.netsuite_id AND l.netsuite_active=true
              AND l.item_type IN ('InvtPart','NonInvtPart') AND l.netsuite_order_line IS NOT NULL
              ${stage?"AND l.line_stage='"+stage+"'":''}) ORDER BY h.netsuite_id DESC LIMIT 1`)).rows[0];
          assert.ok(candidate);
          const source=await resolve({...candidate,order_type:type},{functionKey});
          assert.ok(source.availableLines.length>0);
          assert.ok(source.availableLines.every(l=>Number.isSafeInteger(l.orderLine)&&l.orderLine>0));
          replays.push({type,functionKey,sourceId:source.sourceNetSuiteId,lines:source.availableLines.length});
        }
        const split=await resolve({netsuite_id:-81664606940713,tranid:'SN1400625',order_type:'purchase_order',lines:[]},{functionKey:'receiving'});
        assert.equal(split.sourceNetSuiteId,939701);
        replays.push({split:'SN1400625',sourceId:split.sourceNetSuiteId,lines:split.availableLines.length});
        console.log(JSON.stringify({enabled:config.netsuite.operatorStoredOrderLinePosting,replays,netSuiteWrites:0,
          photoJobs:(await query('SELECT status,count(*)::int FROM operator_posting_photo_uploads GROUP BY status')).rows}));}
      finally {await closeDb();}""")
    assert runtime["enabled"]
    return {"health": core.health(), "publicHealth": 200, "runtime": runtime, "image": core.IMAGE,
            "dependenciesUnchanged": True, "priorIrFixPreserved": True}


def apply():
    regression_gate()
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    assert [row["Id"] for row in core.inspect(*core.SERVICES, *core.DEPENDENCIES)] == [row["Id"] for row in before]
    config_gate(before, manifest["imageId"])
    active = core.node_read("""import {query,closeDb} from './src/db.js';try {console.log(JSON.stringify((await query(
      `SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','attention','finalizing')) AS postings,
       (SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running') AS webhooks`)).rows[0]));}finally {await closeDb();}""")
    assert int(active["postings"]) == int(active["webhooks"]) == 0, "Posting work is active; retry cutover when idle"
    command = ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app", "webhook-worker"]
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with (core.RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(core.compose(before, "compose.release.yml") + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        core.wait_ready(manifest["imageId"])
        result = verify()
        for name, container in zip(["app", "worker"], core.SERVICES):
            logs = core.run("docker", "logs", "--since", started, container, stderr=subprocess.STDOUT).decode()
            (core.RELEASE / f"{name}-startup.log").write_text(logs)
            assert not re.search(r"SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException|operator_photo_worker_error", logs)
            if name == "worker":
                assert "NetSuite order webhook serial worker" in logs and "started." in logs
        core.save("result.json", {"deployed": True, "at": started, **result})
        print(json.dumps({"deployed": True, **result}), flush=True)
    except Exception:
        with (core.RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(core.compose(before, "compose.rollback.yml") + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        core.wait_ready(core.BASE_IMAGE)
        core.save("rolled-back.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    source_gate()
    if mode == "prepare":
        prepare()
    elif mode == "apply":
        apply()
    else:
        print(json.dumps(verify()))
