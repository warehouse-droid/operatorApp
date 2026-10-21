"""Run real mutants in a disposable source copy; never edit the shared tree."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
artifacts = root / "test-artifacts/mbt-bin-planning/mutations"
artifacts.mkdir(parents=True, exist_ok=True)
domain = "src/mbt/bin-planning-domain.js"
unit = "test/mbt/unit/bin-planning-domain.test.js"
properties = "test/mbt/property/bin-planning-properties.test.js"
mutants = [
    ("bin-protection", domain,
     "if (canonicalJson(protectedBins(previous)) !== canonicalJson(protectedBins(next))) {", "if (false) {", unit, True),
    ("capacity-boundary", domain, "aboard.size > route.slotCapacity", "aboard.size >= route.slotCapacity", unit, True),
    ("sequence-direction", domain, "const target = index + direction;", "const target = index - direction;", unit, True),
    ("withdrawal", "src/mbt/bin-planning-service.js", "await withdrawPlanningAssignment(visit, input);", "/* mutation: skip withdrawal */", "test/mbt/integration/bin-planning-driver.test.js", False),
    ("unpublished-driver", "src/driver-repository.js", "!stop.mbt?.planningGeneration || stop.mbt.driverReleased === true", "true", "test/mbt/integration/bin-planning-driver.test.js", False),
    ("lease-expiry", "src/dispatch-plan-write.js", "await assertDispatchPlanEditLease(editLease);", "/* mutation: skip final expiry check */", "test/mbt/concurrency/bin-planning-race.test.js", False),
]
hashes = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for _, file, *_ in mutants}
results = []
with tempfile.TemporaryDirectory(prefix="bin-planning-mutations-") as temporary:
    copied = Path(temporary)
    for directory in ["src", "public", "test", "migrations", "tools", "contracts"]:
        shutil.copytree(root / directory, copied / directory)
    for file in root.iterdir():
        if file.is_file() and file.suffix in [".json", ".js", ".mjs"]:
            shutil.copy2(file, copied / file.name)
    for name, file, old, new, suite, property_only in mutants:
        target = copied / file
        original = target.read_bytes()
        source = original.decode()
        if source.count(old) != 1:
            raise RuntimeError(f"Mutant {name} must match exactly once")
        try:
            target.write_text(source.replace(old, new))
            for layer, test in [("example", suite)] + ([("property", properties)] if property_only else []):
                check = f"mutant-{name}-{layer}"
                env = dict(os.environ, BIN_PLANNING_CHECK=check, BIN_PLANNING_SOURCE_ROOT=str(copied))
                log = artifacts / f"{check}.log"
                with log.open("w") as output:
                    result = subprocess.run(["bash", str(root / "tools/bin-planning-test.sh"), "node", "--test", test],
                                            cwd=root.parent, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=180)
                evidence = log.read_text()
                killed = result.returncode != 0 and "not ok" in evidence and "SyntaxError" not in evidence
                results.append(dict(mutant=name, layer=layer, killed=killed, exit_code=result.returncode))
                print(f"{check}: {'KILLED' if killed else 'SURVIVED OR INVALID'}", flush=True)
                if not killed:
                    raise RuntimeError(f"Mutant {check} was not killed by a behavioral failure; see {log}")
        finally:
            target.write_bytes(original)
        assert target.read_bytes() == original
assert hashes == {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in hashes}
(artifacts / "results.json").write_text(json.dumps(dict(results=results, original_source_unchanged=True, source_hashes=hashes), indent=2))
