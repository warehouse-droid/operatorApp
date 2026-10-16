#!/usr/bin/env python3
"""Validate the memory recovery configuration without launching test databases."""

import json
import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
GIB = 1024 ** 3


def compose_config(filename):
    result = subprocess.run(
        ["sudo", "-n", "docker", "compose", "--project-directory", str(ROOT),
         "-f", str(ROOT / filename), "--profile", "*", "config",
         "--no-env-resolution", "--format", "json"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    return json.loads(result.stdout)


class MemoryLimits(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.production = compose_config("docker-compose.yml")
        cls.testing = compose_config("docker-compose.mbt-test.yml")

    def test_ai_budget_is_persistent(self):
        ai = self.production["services"]["ollama"]
        self.assertEqual(int(ai.get("mem_limit", 0)), 6 * GIB)
        self.assertEqual(int(ai.get("mem_reservation", 0)), 4 * GIB)
        self.assertEqual(int(ai.get("memswap_limit", 0)), 6 * GIB)

    def test_every_test_service_has_a_memory_budget(self):
        for name, service in self.testing["services"].items():
            with self.subTest(service=name):
                budget = int(service.get("mem_limit", 0))
                self.assertGreater(budget, 0)
                self.assertLessEqual(budget, 2 * GIB)
                self.assertEqual(int(service.get("memswap_limit", 0)), budget)

    def test_every_test_service_shares_the_aggregate_budget(self):
        for name, service in self.testing["services"].items():
            with self.subTest(service=name):
                self.assertEqual(service.get("cgroup_parent"), "mbbs-tests.slice")

    def test_test_processes_are_reaped_and_bounded(self):
        for name, service in self.testing["services"].items():
            with self.subTest(service=name):
                self.assertIs(service.get("init"), True)
                self.assertGreater(int(service.get("pids_limit", 0)), 0)
                self.assertLessEqual(int(service.get("pids_limit", 0)), 512)

    def test_every_test_tmpfs_is_sized(self):
        for name, service in self.testing["services"].items():
            for mount in service.get("tmpfs", []):
                with self.subTest(service=name, mount=mount):
                    self.assertRegex(mount, r"(?:^|[:,])size=\d+[mk](?:,|$)")

    def test_aggregate_unit_limits_host_exposure(self):
        source = (ROOT / "docker" / "mbbs-tests.slice").read_text()
        values = dict(line.split("=", 1) for line in source.splitlines()
                      if "=" in line and not line.startswith("#"))
        self.assertEqual(values.get("MemoryHigh"), "3G")
        self.assertEqual(values.get("MemoryMax"), "4G")
        self.assertEqual(values.get("MemorySwapMax"), "0")
        self.assertEqual(values.get("CPUQuota"), "200%")
        self.assertEqual(values.get("TasksMax"), "2048")


if __name__ == "__main__":
    unittest.main(verbosity=2)
