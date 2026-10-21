"""Run real mutants in a disposable source copy; never edit the shared tree."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
artifacts = root / "test-artifacts/bin-planner-reuse/mutations"
artifacts.mkdir(parents=True, exist_ok=True)
board = "src/mbt/bin-planning-board.js"
properties = "test/mbt/property/bin-planning-board-properties.test.js"
unit = "test/mbt/integration/bin-planning-board.test.js"
mutants = [
    ("duplicate-visit", board, "seen.has(visit.visitId)", "false", properties, True),
    ("ordinary-load-protection", board, "prior && !isBinBoardLoad(prior.truck, prior.load)", "false", properties, True),
    ("negative-stop-time", "src/mbt/bin-planning-metadata.js", "value >= 0 && value <= limit", "value <= limit", properties, True),
    ("restage-unchanged", board, "!sameLoad(existing.get(l.id), l)", "true", unit, False),
    ("metadata-loss", "src/mbt/bin-planning-service.js", "applyPlanningStopTimings(saved, input, stopTimings, visit);", "/* mutation: discard computed timing */", unit, False),
    ("board-expired-lease", "src/dispatch-plan-write.js", "await assertDispatchPlanEditLease(editLease);", "/* mutation: bypass final lease fence */", unit, False),
    ("empty-draft-start", "src/mbt/bin-planning-service.js", 'throw planningError(400, "MBT_BIN_LOAD_TIME_REQUIRED", "Choose a valid start time within the plan day.");', "/* mutation: accept invalid draft start */", unit, False),
    ("aborted-event-stream", "src/server.js", "if (res.destroyed || res.writableEnded) return;", "/* mutation: open an already closed response */", "test/mbt/integration/bin-planning-events.test.js", False),
    ("unconfirmed-return", "src/driver-repository.js", "load.returnOnly && load.mbtReturnReleased === true", "load.returnOnly", "test/mbt/integration/bin-planning-returns.test.js", False),
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
                check = f"reuse-mutant-{name}-{layer}"
                env = dict(os.environ, BIN_PLANNING_CHECK=check, BIN_PLANNING_SOURCE_ROOT=str(copied))
                log = artifacts / f"{check}.log"
                with log.open("w") as output:
                    pattern = ["--test-name-pattern=^(board validation|bounded step timings)"] if layer == "property" else []
                    result = subprocess.run(["bash", str(root / "tools/bin-planning-test.sh"), "node", "--test", *pattern, test],
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
