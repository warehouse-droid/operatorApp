#!/usr/bin/env python3
"""Verify the hotfix, effective limits, cleanup, and public health on this host."""

import datetime
import hashlib
import json
import pathlib
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED = {
    "mbbs-operator-app-app-1", "mbbs-operator-app-db-1",
    "mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-ollama-1",
}
GIB = 1024 ** 3


def run(args):
    result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=45)
    return result.stdout


def containers():
    ids = run(["sudo", "-n", "docker", "ps", "-aq"]).split()
    return json.loads(run(["sudo", "-n", "docker", "inspect", *ids])) if ids else []


def verify():
    baseline = json.loads(pathlib.Path(
        "/home/ubuntu/operatorapp-investigations/server-outages-20261005/"
        "evidence-20261005T140910Z.json"
    ).read_text())
    previous = {c["name"]: c for c in baseline["containers"] if c["role"] == "production"}
    current = containers()
    assert {c["Name"].lstrip("/") for c in current} == EXPECTED
    for container in current:
        name = container["Name"].lstrip("/")
        assert container["State"]["Running"], name
        assert container["Id"] == previous[name]["id"], name
        assert container["State"]["StartedAt"] == previous[name]["startedAt"], name
        if "Health" in container["State"]:
            assert container["State"]["Health"]["Status"] == "healthy", name
        if name.endswith("ollama-1"):
            settings = container["HostConfig"]
            assert settings["Memory"] == 6 * GIB
            assert settings["MemoryReservation"] == 4 * GIB
            assert settings["MemorySwap"] == 6 * GIB

    properties = dict(line.split("=", 1) for line in run([
        "sudo", "-n", "systemctl", "show", "mbbs-tests.slice",
        "-p", "ActiveState", "-p", "MemoryHigh", "-p", "MemoryMax",
        "-p", "MemorySwapMax", "-p", "CPUQuotaPerSecUSec", "-p", "TasksMax",
    ]).splitlines())
    assert properties == {
        "ActiveState": "active", "MemoryHigh": str(3 * GIB),
        "MemoryMax": str(4 * GIB), "MemorySwapMax": "0",
        "CPUQuotaPerSecUSec": "2s", "TasksMax": "2048",
    }, properties

    probe = run([
        "sudo", "-n", "docker", "run", "--rm", "--name", "mbbs-memory-budget-probe",
        "--network", "none", "--cgroup-parent=mbbs-tests.slice", "--init",
        "--memory=32m", "--memory-swap=32m", "--pids-limit=32", "--cpus=0.1",
        "--label", "com.mbbs.lifecycle=disposable-test", "--entrypoint", "/bin/sh",
        "postgres:18-alpine", "-c",
        "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max",
    ])
    assert probe.splitlines() == [str(32 * 1024 ** 2), "0", "32"], probe
    assert {c["Name"].lstrip("/") for c in containers()} == EXPECTED
    assert "mbbs-special-review-db" not in run(["sudo", "-n", "docker", "volume", "ls", "-q"]).split()
    network_names = run(["sudo", "-n", "docker", "network", "ls", "--format", "{{.Name}}"]).split()
    assert not [n for n in network_names if n.startswith("mbbs-") and n not in {
        "mbbs-operator-app_mbbs", "mbbs-operator-app-v2_mbbs"
    }], network_names

    health = {}
    for url in ["http://127.0.0.1:3000/health", "https://test.mbbsoperation.com/health"]:
        response = run(["curl", "--max-time", "15", "-sS", "-o", "/dev/null",
                        "-w", "%{http_code} %{time_total}", url]).split()
        assert response[0] == "200", (url, response)
        health[url] = {"status": 200, "seconds": float(response[1])}
    run(["sudo", "-n", "docker", "exec", "mbbs-operator-app-db-1", "sh", "-c",
         'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1"'])

    memory = dict((key.rstrip(":"), int(value)) for key, value, *_ in
                  (line.split() for line in pathlib.Path("/proc/meminfo").read_text().splitlines()))
    assert memory["MemAvailable"] > 8 * 1024 ** 2, memory["MemAvailable"]
    since = datetime.datetime.fromtimestamp(
        (ROOT / "docker" / "memory-recovery-spec.json").stat().st_mtime,
        datetime.timezone.utc,
    ).strftime("%Y-%m-%d %H:%M:%S UTC")
    recent_oom = run(["sudo", "-n", "journalctl", "-k", "--since", since,
                      "--no-pager", "-o", "short-iso"])
    assert not any("global_oom" in line or "Out of memory: Killed" in line
                   for line in recent_oom.splitlines()), "New OOM after cleanup"
    tracked = ["AGENTS.md", "docker-compose.yml", "docker-compose.mbt-test.yml",
               "docker/mbbs-tests.slice", "docker/verify-memory-limits.py",
               "docker/check-memory-limit-mutations.py", "docker/verify-memory-recovery-live.py"]
    return {
        "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "remainingContainers": sorted(EXPECTED), "remainingTestContainers": 0,
        "productionRestarted": False, "health": health,
        "availableMemoryGiB": round(memory["MemAvailable"] / 1024 ** 2, 2),
        "aiMemoryLimitGiB": 6, "testAggregateLimitGiB": 4,
        "sliceProperties": properties, "probePassedAndRemoved": True,
        "newOOMSince": since, "newOOMCount": 0,
        "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                         for name in tracked},
    }


if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))
