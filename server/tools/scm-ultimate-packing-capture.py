"""Capture code and bounded, read-only planning fixtures without credentials."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / "test-artifacts/scm-ultimate-packing-20261005"
APP = "mbbs-operator-app-app-1"


def docker(*args, **kwargs):
    return subprocess.check_output(["sudo", "-n", "docker", *args], **kwargs)


def capture():
    ARTIFACT.mkdir(parents=True, exist_ok=True)
    before = json.loads(docker("inspect", APP))[0]
    baseline = ARTIFACT / "baseline"
    baseline.mkdir(exist_ok=False)
    archive = docker("exec", APP, "tar", "-cf", "-", "-C", "/app",
                     "src", "public", "migrations", "package.json", "package-lock.json")
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter="data")
    after = json.loads(docker("inspect", APP))[0]
    assert (before["Id"], before["Image"]) == (after["Id"], after["Image"])
    candidate = ARTIFACT / "candidate"
    shutil.copytree(baseline, candidate)
    for folder in ["test", "tools", "contracts"]:
        if (SERVER / folder).exists():
            shutil.copytree(SERVER / folder, candidate / folder,
                            ignore=shutil.ignore_patterns("__pycache__"))
    for filename in ["eslint.mbt.config.js", "tsconfig.mbt.json", ".c8rc.json"]:
        if (SERVER / filename).exists():
            shutil.copy2(SERVER / filename, candidate / filename)

    sql = """
    WITH selected AS (
      SELECT id, completed_at, settings_snapshot FROM scm_smart_planning_runs
       WHERE plan_kind = 'inventory' AND status = 'ready'
       ORDER BY id DESC LIMIT 20
    )
    SELECT r.id, r.completed_at, r.settings_snapshot,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'proposalType', p.proposal_type, 'phase', p.phase,
        'sourceKind', p.source_kind, 'sourceLocationId', p.source_location_id,
        'sourceVendorYardId', p.source_vendor_yard_id, 'sourceName', p.source_name,
        'vendor', p.vendor, 'plant', p.plant,
        'destinationLocationId', p.destination_location_id,
        'destinationName', p.destination_name, 'status', p.status,
        'proposalKey', p.proposal_key, 'proposalOrigin', p.proposal_origin,
        'lines', (SELECT jsonb_agg(jsonb_build_object(
          'itemId', l.item_id, 'itemName', l.item_name,
          'itemDescription', l.item_description, 'unit', l.unit,
          'destinationLocationId', l.destination_location_id,
          'destinationName', l.destination_name,
          'requiredPallets', l.required_pallets,
          'proposedPallets', l.proposed_pallets,
          'confirmedPallets', l.confirmed_pallets,
          'residualPallets', l.residual_pallets, 'salesQuantity', l.sales_quantity,
          'palletWeight', l.pallet_weight_lbs,
          'physicalPalletWeightLbs', l.reason->'physicalPalletWeightLbs',
          'lineWeight', l.line_weight_lbs, 'toPlt', l.to_plt,
          'toLyr', l.to_lyr, 'toSec', l.to_sec, 'toPcs', l.to_pcs,
          'urgencyLevel', l.urgency_level, 'urgencyScore', l.urgency_score,
          'urgent', l.urgent, 'provisional', l.provisional,
          'manualPlanningRequired', l.manual_planning_required,
          'reason', l.reason
        ) ORDER BY l.id) FROM scm_smart_proposal_lines l WHERE l.proposal_id = p.id)
      ) ORDER BY p.id) FROM scm_smart_proposals p
      WHERE p.run_id = r.id AND p.proposal_key LIKE 'load:%'
        AND COALESCE(p.proposal_origin, 'inventory') = 'inventory'
        AND NOT p.manually_grouped AND p.regular_replenishment_id IS NULL),
      '[]'::jsonb) AS proposals
    FROM selected r ORDER BY r.id DESC
    """
    script = """
    import {query, withTransaction, closeDb} from './src/db.js';
    try {
      await withTransaction(async () => {
        await query('SET TRANSACTION READ ONLY');
        await query(\"SET LOCAL statement_timeout = '15s'\");
        await query(\"SET LOCAL lock_timeout = '1s'\");
        const plans = (await query(SQL)).rows;
        const rules = (await query('SELECT source_key, source_name, enabled, max_drops, stop_order, partial_redirect_enabled, partial_redirect_destination_ids, partial_redirect_hub_location_id FROM scm_smart_route_rules ORDER BY source_key')).rows;
        console.log(JSON.stringify({capturedAt: new Date().toISOString(), plans, rules}));
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await closeDb(); }
    """.replace("SQL", json.dumps(sql))
    fixture = docker("exec", "-i", APP, "node", "--input-type=module", input=script.encode())
    parsed = json.loads(fixture)
    target = ARTIFACT / "replay-input.json"
    target.write_bytes(fixture)
    target.chmod(0o600)
    state = {
        "containerId": before["Id"], "baseImageId": before["Image"],
        "baseImage": before["Config"]["Image"],
        "composeFiles": before["Config"]["Labels"]["com.docker.compose.project.config_files"],
        "sourceHashes": {str(p.relative_to(baseline)): hashlib.sha256(p.read_bytes()).hexdigest()
                         for folder in ["src", "public", "migrations"]
                         for p in (baseline / folder).rglob("*") if p.is_file()},
        "fixtureHash": hashlib.sha256(fixture).hexdigest(),
        "planIds": [int(p["id"]) for p in parsed["plans"]],
    }
    (ARTIFACT / "capture.json").write_text(json.dumps(state, indent=2) + "\n")
    print(json.dumps({"capturedPlans": len(parsed["plans"]), "planIds": state["planIds"],
                      "automaticProposals": sum(len(p["proposals"]) for p in parsed["plans"]),
                      "baseImage": state["baseImage"]}))


if __name__ == "__main__":
    capture()
