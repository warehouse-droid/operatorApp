import json
import random
import tempfile
import unittest
import subprocess
import sys
from unittest import mock
from pathlib import Path

import timings
from timings import Store, parse_line, summarize

COMMAND = '55618248-4bc5-4fe7-9d3c-85a9d2da8775'


def event(operation='netsuite.http', duration=2000, end=10, **fields):
    return dict(event='operator_posting_timing', commandId=COMMAND,
                at=f'2026-10-21T15:00:{end:02d}.000Z', operation=operation,
                durationMs=duration, transactionType='IF', outcome='ok', **fields)


def line(data):
    return '2026-10-21T15:00:11.123456789Z ' + json.dumps(data)


class TimingTests(unittest.TestCase):
    def test_allowlist_drops_secrets_and_query_parameters(self):
        data = event(path='/app/site/hosting/restlet.nl?secret=private',
                     Authorization='private', payload={'secret': 'private'}, message='private')
        parsed = parse_line(line(data))
        self.assertEqual(parsed['event']['path'], '/app/site/hosting/restlet.nl')
        self.assertNotIn('private', json.dumps(parsed))
        self.assertEqual(parsed['docker_at'], '2026-10-21T15:00:11.123456789Z')

    def test_malformed_or_fabricated_intervals_are_rejected(self):
        for raw in ['unrelated log', '{}', 'x' * 20000, line({}), line(event(duration=-1)),
                    line(event(duration=float('inf'))), line(event(duration=True)),
                    line(dict(event(), at='not-a-date')), line(dict(event(), commandId='../secret'))]:
            self.assertIsNone(parse_line(raw))

    def test_restart_and_replay_are_idempotent_and_replacement_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'timings.sqlite'
            with Store(path) as store:
                self.assertEqual(store.ingest('container-a', line(event())), 1)
                self.assertEqual(store.ingest('container-a', line(event())), 0)
                self.assertEqual(store.ingest('container-a', 'unrelated secret'), 0)
            with Store(path) as store:
                self.assertEqual(store.ingest('container-a', line(event())), 0)
                self.assertEqual(store.ingest('container-b', line(event(end=12))), 1)
                self.assertEqual(len(store.events()), 2)
                self.assertEqual(store.checkpoint('container-a'), '2026-10-21T15:00:11.123456789Z')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(b'secret', path.read_bytes())

    def test_nested_and_parallel_intervals_do_not_inflate_elapsed_time(self):
        data = [event('posting.admission', 10000, 10), event('posting.source_validation', 9000, 10),
                event('netsuite.queue', 6000, 6, queue='shared_background'),
                event('netsuite.queue', 4000, 5, queue='suiteql'),
                event('netsuite.http', 4000, 10, path='/services/rest/query/v1/suiteql'),
                event('netsuite.http', 3000, 10, path='/services/rest/query/v1/suiteql'),
                event('posting.transform', 5000, 15), event('netsuite.http', 4000, 15,
                      path='/app/site/hosting/restlet.nl', method='POST'),
                event('posting.finalization', 1000, 16)]
        result = summarize(data)
        self.assertEqual(result['observedElapsedMs'], 16000)
        self.assertEqual(result['queueMs'], 6000)
        self.assertEqual(result['httpMs'], 8000)
        self.assertEqual(result['remoteOrQueueMs'], 14000)
        self.assertEqual(result['unattributedMs'], 2000)
        self.assertEqual(result['operations']['posting.admission']['wallMs'], 10000)
        self.assertEqual(result['warnings'], [])

    def test_queue_and_http_overlap_is_explicit(self):
        result = summarize([event('netsuite.queue', 5000, 10, queue='operator'), event(duration=5000, end=8)])
        self.assertEqual(result['observedElapsedMs'], 7000)
        self.assertEqual(result['remoteOrQueueMs'], 7000)
        self.assertEqual(result['queueHttpOverlapMs'], 3000)
        self.assertGreater(len(result['warnings']), 0)

    def test_interval_property_order_duplicates_and_bounds(self):
        rng = random.Random(20261021)
        for _ in range(100):
            data = [event('netsuite.queue' if i % 2 else 'netsuite.http',
                          rng.randint(0, 9000), rng.randint(10, 59)) for i in range(20)]
            before = summarize(data)
            rng.shuffle(data)
            after = summarize(data + data)
            for key in ('observedElapsedMs', 'queueMs', 'httpMs', 'remoteOrQueueMs', 'unattributedMs'):
                self.assertEqual(before[key], after[key])
                self.assertGreaterEqual(before[key], 0)
                self.assertLessEqual(before[key], before['observedElapsedMs'])

    def test_bounded_reader_recovers_after_an_oversized_line(self):
        buffer, dropping, output = b'', False, []
        raw = ('x' * 40000 + '\n' + line(event()) + '\n').encode()
        for start in range(0, len(raw), 817):
            lines, buffer, dropping = timings.bounded_lines(buffer, raw[start:start+817], dropping)
            output.extend(lines)
            self.assertLessEqual(len(buffer), timings.MAX_LINE)
        self.assertEqual(len(output), 1)
        self.assertEqual(parse_line(output[0])['event']['commandId'], COMMAND)

    def test_follow_detects_replacement_and_terminates_old_reader(self):
        with tempfile.TemporaryDirectory() as directory, Store(Path(directory) / 'events.sqlite') as store:
            process = subprocess.Popen([sys.executable, '-c',
                'import sys,time;print(sys.argv[1],flush=True);time.sleep(30)', line(event())],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                with mock.patch.object(timings.subprocess, 'Popen', return_value=process), \
                        mock.patch.object(timings, 'inspect_container', return_value='container-b'), \
                        mock.patch.object(timings.time, 'monotonic', side_effect=[0, 6]):
                    timings.follow(store, 'app', 'container-a', '2026-10-21T00:00:00Z', lambda: False)
                self.assertIsNotNone(process.poll())
                self.assertEqual(len(store.events()), 1)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    def test_real_cli_ingest_report_and_time_window(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = [sys.executable, '-B', str(Path(timings.__file__)), '--db', str(Path(directory) / 'events.sqlite')]
            raw = '\n'.join(line(item) for item in [event('posting.admission', 5000, 10),
                                                   event('posting.finalization', 1000, 11)]) + '\n'
            for expected in (2, 0):
                result = subprocess.run(cli + ['ingest', '--container', 'app'], input=raw,
                                        capture_output=True, text=True, check=True)
                self.assertEqual(json.loads(result.stdout)['inserted'], expected)
            args = ['report', '--json', '--since', '2026-10-21T15:00:10.500Z']
            result = json.loads(subprocess.check_output(cli + args, text=True))
            self.assertEqual(result['stats']['IF']['count'], 1)
            self.assertEqual(result['commands'][0]['observedElapsedMs'], 6000)
            result = subprocess.check_output(cli + ['report', '--command-id', COMMAND], text=True)
            self.assertIn('posting.admission: 5.000s', result)
            self.assertIn('overlap', result)


if __name__ == '__main__':
    unittest.main()
