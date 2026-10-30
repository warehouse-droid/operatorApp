import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import retention
import host_retention


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'eligible'
        self.root.mkdir()

    def file(self, name, text='payload'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_latest_five_properties(self):
        for n in range(21):
            entries = [(str(i), i) for i in range(n)]
            kept = retention.choose_newest(entries)
            self.assertEqual(set(kept), {str(i) for i in range(max(0, n - 5), n)})
            self.assertEqual(len(kept), min(5, n))

    def test_live_preflight_requires_all_production_and_health(self):
        rows = [{'Name': '/' + name, 'State': {'Running': True, 'Health': {'Status': 'healthy'}}}
                for name in host_retention.PRODUCTION]
        self.assertTrue(host_retention.validate_containers(rows))
        with self.assertRaises(ValueError):
            host_retention.validate_containers(rows[:-1])
        rows[0]['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaises(ValueError):
            host_retention.validate_containers(rows)

    def test_operational_records_and_snapshots_are_preserved(self):
        for name in ['audit-before.json', 'production-snapshot.dump', 'compose.release.yml',
                     'EVIDENCE.md', 'reconciliation.csv', '.env']:
            self.assertTrue(host_retention.is_operational(Path(name), True), name)
        for name in ['coverage.json', 'test.log', 'chromium', 'candidate.js', 'trace.zip']:
            self.assertFalse(host_retention.is_operational(Path(name), True), name)

    def test_forged_plan_cannot_delete_retained_deployment(self):
        copies = []
        for i in range(6):
            item = self.file(f'copy-{i}/code.js')
            os.utime(item.parent, (100 + i, 100 + i))
            copies.append(item.parent)
        kept = retention.choose_newest([(str(p), p.stat().st_mtime_ns) for p in copies])
        plan = {'services': {}, 'keptDeployments': kept,
                'actions': retention.plan_tree(copies[-1])}
        with patch.object(host_retention, 'DEPLOYMENTS', (self.root,)), \
             patch.object(host_retention, 'ROOTS', (self.root,)), \
             patch.object(host_retention, 'live_context', return_value=({}, set(), False)), \
             patch.object(host_retention, 'tracked_files', return_value=set()), \
             patch.object(host_retention, 'used_paths', return_value=set()):
            with self.assertRaises(ValueError):
                host_retention.ensure_current(plan)

    def test_active_run_lease_protects_long_running_job(self):
        lease = self.file('.runs/run-active/.active-run.json', '{}')
        import json
        start = Path(f'/proc/{os.getpid()}/stat').read_text().rpartition(')')[2].split()[19]
        lease.write_text(json.dumps({'pid': os.getpid(), 'processStart': start, 'started': 1}))
        with patch.object(host_retention, 'ARTIFACTS', self.root):
            self.assertIn(str(lease.parent), host_retention.active_runs())
            lease.write_text(json.dumps({'pid': os.getpid(), 'processStart': 'wrong', 'started': 1}))
            self.assertNotIn(str(lease.parent), host_retention.active_runs())

    def test_copied_source_is_not_misclassified_as_audit_data(self):
        for name in ['candidate/migrations/034_photo_archive_snapshot.sql',
                     'before/test/audit-fixture.json', 'candidate/node_modules/lib/manifest.json']:
            self.assertFalse(host_retention.is_operational(Path(name), True), name)
        self.assertTrue(host_retention.is_operational(Path('audit/production-before.json'), True))

    def test_periodic_sweep_preserves_empty_roots_and_removes_loose_artifacts(self):
        deployments = self.root / 'deployments'
        backups = self.root / 'deployment-backups'
        artifacts = self.root / 'test-artifacts'
        for root in (deployments, backups, artifacts):
            root.mkdir()
        for index in range(6):
            copy = deployments / f'copy-{index}'
            copy.mkdir()
            (copy / 'code.js').write_text('old source')
            os.utime(copy, (100 + index, 100 + index))
        loose = artifacts / 'test.log'
        loose.write_text('temporary')
        roots = (deployments, backups, artifacts)
        with patch.object(host_retention, 'DEPLOYMENTS', (deployments, backups)), \
             patch.object(host_retention, 'ROOTS', roots), \
             patch.object(host_retention, 'ARTIFACTS', artifacts), \
             patch.object(host_retention, 'live_context', return_value=({}, set(), False)), \
             patch.object(host_retention, 'tracked_files', return_value=set()), \
             patch.object(host_retention, 'used_paths', return_value=set()):
            plan = host_retention.build_plan(0)
            self.assertFalse(any(a['path'] in {str(r) for r in roots} for a in plan['actions']))
            retention.apply_actions(plan['actions'])
            self.assertTrue(all(r.is_dir() for r in roots))
            self.assertFalse(loose.exists())
            self.assertEqual(len(list(deployments.iterdir())), 5)
            self.assertEqual(host_retention.build_plan(0)['actions'], [])

    def test_tie_is_deterministic_and_invalid_count_rejected(self):
        self.assertEqual(retention.choose_newest([('b', 1), ('a', 1)], 1), ['b'])
        with self.assertRaises(ValueError):
            retention.choose_newest([('a', 1)], 0)

    def test_dry_run_then_delete_only_eligible(self):
        candidate = self.file('old/cache.bin')
        outside = self.base / 'production-sentinel'
        outside.write_text('live')
        actions = retention.plan_tree(self.root)
        self.assertTrue(candidate.exists())
        self.assertTrue(actions)
        retention.apply_actions(actions)
        self.assertFalse(candidate.exists())
        self.assertEqual(outside.read_text(), 'live')

    def test_protected_descendant_and_sibling(self):
        config = self.file('old/compose.release.yml')
        tracked = self.file('old/README.md')
        cache = self.file('old/source/code.js')
        retention.apply_actions(retention.plan_tree(self.root, [config, tracked]))
        self.assertTrue(config.exists())
        self.assertTrue(tracked.exists())
        self.assertFalse(cache.exists())

    def test_symlink_never_followed_and_root_rejected(self):
        outside = self.base / 'live'
        outside.mkdir()
        sentinel = outside / 'database'
        sentinel.write_text('live')
        (self.root / 'linked').symlink_to(outside, target_is_directory=True)
        self.file('cache.bin')
        retention.apply_actions(retention.plan_tree(self.root))
        self.assertEqual(sentinel.read_text(), 'live')
        self.assertTrue((self.root / 'linked').is_symlink())
        with self.assertRaises(ValueError):
            retention.plan_tree(self.root / 'linked')

    def test_changed_plan_rejected_before_any_deletion(self):
        one = self.file('a/cache')
        two = self.file('b/cache')
        actions = retention.plan_tree(self.root)
        two.write_text('new active data')
        with self.assertRaises(ValueError):
            retention.apply_actions(actions)
        self.assertTrue(one.exists())
        self.assertTrue(two.exists())

    def test_directory_replacement_by_symlink_rejected(self):
        self.file('old/cache')
        actions = retention.plan_tree(self.root)
        moved = self.base / 'moved'
        self.root.rename(moved)
        self.root.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError):
            retention.apply_actions(actions)
        self.assertTrue((moved / 'old/cache').exists())

    def test_recent_tree_preserved(self):
        candidate = self.file('old/new.log')
        os.utime(self.root, (1, 1))
        os.utime(candidate.parent, (1, 1))
        self.assertEqual(retention.plan_tree(self.root, recent_seconds=3600), [])

    def test_idempotent_and_directory_age_preserved(self):
        retained = self.file('config.json')
        self.file('cache.bin')
        os.utime(self.root, (100, 100))
        retention.apply_actions(retention.plan_tree(self.root, [retained]))
        self.assertEqual(int(self.root.stat().st_mtime), 100)
        self.assertEqual(retention.plan_tree(self.root, [retained]), [])

    def test_runner_success_and_failure_remove_artifacts(self):
        for status in (0, 7):
            result = retention.run_disposable(self.root, [sys.executable, '-c',
                'import os,pathlib,sys; p=pathlib.Path(os.environ["MBBS_TEST_ARTIFACT_DIR"]);'
                f'(p/"test.log").write_text("temporary"); sys.exit({status})'])
            self.assertEqual(result, status)
            self.assertEqual(list(self.root.iterdir()), [])

    def test_runner_term_cleans_and_preserves_exit(self):
        runner = subprocess.Popen([sys.executable, str(Path(retention.__file__).resolve()),
            'run', '--root', str(self.root), '--', sys.executable, '-c',
            'import os,pathlib,time; (pathlib.Path(os.environ["MBBS_TEST_ARTIFACT_DIR"])/"started").write_text("yes"); time.sleep(30)'])
        try:
            for _ in range(200):
                if list(self.root.glob('*/started')):
                    break
                time.sleep(.01)
            else:
                self.fail('child did not start')
            runner.send_signal(signal.SIGTERM)
            self.assertEqual(runner.wait(timeout=5), 143)
            self.assertEqual(list(self.root.iterdir()), [])
        finally:
            if runner.poll() is None:
                runner.kill()
                runner.wait()


if __name__ == '__main__':
    unittest.main()
