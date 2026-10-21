#!/usr/bin/env python3
"""Capture read-only historical topology; persist only anonymized test fixtures."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FROM_DATE = "2026-10-07"
TO_DATE = "2026-10-13"
SQL = """
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'capturedAt', now(), 'fromDate', '2026-10-07', 'toDate', '2026-10-13',
  'plans', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'planDate', p.plan_date, 'revision', p.revision,
    'orders', s.orders, 'trucks', s.trucks, 'summary', s.summary
  ) ORDER BY p.plan_date), '[]'::jsonb)
  FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
  WHERE p.plan_date BETWEEN '2026-10-07' AND '2026-10-13' AND p.status = 'confirmed'),
  'jobs', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'jobId', job_id, 'planDate', plan_date, 'driverLogin', driver_login,
    'stopType', stop_type, 'originalStatus', status,
    'orderRefCount', jsonb_array_length(order_refs), 'photoCount', jsonb_array_length(photo_data_urls),
    'physicalVisitJobIds', job_details->'physicalVisitJobIds'
  ) ORDER BY plan_date, id), '[]'::jsonb)
  FROM driver_job_records WHERE plan_date BETWEEN '2026-10-07' AND '2026-10-13'),
  'drivers', (SELECT jsonb_agg(jsonb_build_object('login', login, 'name', name)) FROM dispatch_drivers)
);
ROLLBACK;
"""

def fingerprint(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:16]

def main():
    captured = subprocess.run([
        "docker", "exec", "-i", "mbbs-operator-app-db-1", "sh", "-c",
        'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    ], input=SQL, text=True, capture_output=True, check=True)
    source = json.loads(captured.stdout)
    identities = {}
    for driver in source.pop("drivers"):
        alias = f"history-{fingerprint(driver['login'])[:10]}"
        identities[str(driver["login"])] = alias
        identities[str(driver["name"])] = alias
    refs = {}
    for plan in source["plans"]:
        for order in plan["orders"]:
            ref = str(order.get("id") or "")
            if ref:
                match = re.match(r"[A-Z]+", ref)
                prefix = match[0] if match else "HIST"
                refs[ref] = prefix + str(int(fingerprint(ref), 16) % 100000000).zfill(8)
    ordered = sorted(refs.items(), key=lambda item: -len(item[0]))

    def anonymize(value, field=""):
        if isinstance(value, dict):
            return {key: anonymize(item, key) for key, item in value.items()
                    if not re.search(r"password|secret|token|credential|email|phone|photoData|signature|driverRemark", key, re.I)}
        if isinstance(value, list):
            return [anonymize(item, field) for item in value]
        if not isinstance(value, str):
            return value
        if value.startswith(("r2://", "data:")):
            return ""
        if value in identities:
            return identities[value]
        if re.search(r"address|street|postal", field, re.I) and value:
            return f"{int(fingerprint(value), 16) % 1000 + 1} Fixture Avenue, Toronto, ON"
        if field in ("customer", "customerName", "vendorName", "contact", "notes", "note") and value:
            return "Historical fixture"
        for original, alias in ordered:
            value = value.replace(original, alias)
        return re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]+", "fixture@example.test", value)

    jobs = []
    for job in source["jobs"]:
        members = sorted(job.get("physicalVisitJobIds") or [job["jobId"]])
        jobs.append({
            "sourceKey": hashlib.md5(job["jobId"].encode(), usedforsecurity=False).hexdigest(),
            "visitKey": hashlib.md5(json.dumps(members).encode(), usedforsecurity=False).hexdigest(),
            "driverKey": fingerprint(job["driverLogin"]), "planDate": job["planDate"],
            "stopType": job["stopType"], "originalStatus": job["originalStatus"],
            "orderRefCount": job["orderRefCount"], "photoCount": job["photoCount"],
            "requiredPhotos": 0 if job["stopType"] in ("travel", "truck_switch") else 2
        })
    groups = {}
    for job in jobs:
        groups[job["visitKey"]] = groups.get(job["visitKey"], 0) + 1
    for job in jobs:
        job["declaredVisitSize"] = groups[job["visitKey"]]
    fixture = {"readOnly": True, "fromDate": FROM_DATE, "toDate": TO_DATE,
               "capturedAt": source["capturedAt"], "plans": anonymize(source["plans"]), "jobs": jobs,
               "reportingDriverKey": fingerprint("aurther")}
    target = ROOT / "test/fixtures/driver-upload-history.json"
    target.write_text(json.dumps(fixture, indent=2) + "\n")
    artifact = ROOT / "test-artifacts/driver-upload-reliability"
    artifact.mkdir(parents=True, exist_ok=True)
    summary = {"capturedAt": fixture["capturedAt"], "fromDate": FROM_DATE, "toDate": TO_DATE,
               "jobRecords": len(jobs), "plans": len(fixture["plans"]),
               "drivers": len({job["driverKey"] for job in jobs}),
               "fixtureSha256": hashlib.sha256(target.read_bytes()).hexdigest(), "byDate": {}}
    from datetime import date, timedelta
    current = date.fromisoformat(FROM_DATE)
    while current <= date.fromisoformat(TO_DATE):
        day = current.isoformat()
        rows = [job for job in jobs if job["planDate"] == day]
        summary["byDate"][day] = {"jobRecords": len(rows), "drivers": len({row["driverKey"] for row in rows}),
                                  "plans": len([plan for plan in fixture["plans"] if plan["planDate"] == day])}
        current += timedelta(days=1)
    (artifact / "historical-capture.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
