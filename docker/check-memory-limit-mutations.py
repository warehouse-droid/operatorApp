#!/usr/bin/env python3
"""Run the configuration assertions against five real Compose mutations."""

import importlib.util
import io
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "memory_checks", ROOT / "docker" / "verify-memory-limits.py"
)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
original_compose = checks.compose_config
mutations = [
    ("AI budget raised above 6 GiB", "docker-compose.yml", "mem_limit: 6g", "mem_limit: 8g"),
    ("Test memory budget removed", "docker-compose.mbt-test.yml", "  mem_limit: 2g\n", ""),
    ("Aggregate test budget bypassed", "docker-compose.mbt-test.yml", "  cgroup_parent: mbbs-tests.slice\n", ""),
    ("Process reaping disabled", "docker-compose.mbt-test.yml", "  init: true\n", "  init: false\n"),
    ("Test tmpfs unbounded", "docker-compose.mbt-test.yml", ",size=128m", ""),
]
results = []
for name, filename, before, after in mutations:
    source = (ROOT / filename).read_text()
    assert before in source, "Mutation target missing: " + name
    with tempfile.TemporaryDirectory(prefix=".memory-mutation-", dir=ROOT / "docker") as temporary:
        target = pathlib.Path(temporary) / filename
        target.write_text(source.replace(before, after, 1))

        def mutated_compose(requested, selected=filename, mutated=target):
            return original_compose(str(mutated) if requested == selected else requested)

        checks.compose_config = mutated_compose
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(checks.MemoryLimits)
        result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
        assert not result.errors, "Mutation produced an infrastructure error: " + name
        assert result.failures, "Mutation survived: " + name
        results.append({"mutation": name, "killed": True})
checks.compose_config = original_compose
print(json.dumps({"killed": len(results), "total": len(mutations), "results": results}, indent=2))
