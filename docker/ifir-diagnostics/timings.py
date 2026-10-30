"""Persistent, allowlisted IF/IR wait diagnostics. Uses only Python's stdlib."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import selectors
import signal
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

EVENT = 'operator_posting_timing'
MAX_LINE = 16384
STAMP = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$')
IDENTIFIER = re.compile(r'^[A-Za-z0-9_.:-]{1,180}$')
UUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')
TEXT_FIELDS = ('stage', 'functionKey', 'sourceOrderKind', 'method', 'queue', 'errorCode')
NUMBER_FIELDS = ('sourceNetSuiteId', 'stepIndex', 'attempt', 'status')
DEFAULT_DB = '/home/ubuntu/operatorapp-operations/ifir-timings/timings.sqlite'


def millis(stamp):
    if not isinstance(stamp, str) or not STAMP.fullmatch(stamp):
        raise ValueError('Expected an ISO UTC timestamp ending in Z')
    return dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000


def timestamp(seconds):
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def docker_stamp(line):
    candidate = line.partition(' ')[0]
    try:
        millis(candidate)
        return candidate
    except (ValueError, OverflowError):
        return None


def clean_event(data):
    if not isinstance(data, dict) or data.get('event') != EVENT:
        return None
    duration = data.get('durationMs')
    if (type(duration) not in (int, float) or not math.isfinite(duration)
            or not 0 <= duration <= 86400000 or not UUID.fullmatch(str(data.get('commandId', '')))
            or not IDENTIFIER.fullmatch(str(data.get('operation', '')))):
        return None
    try:
        millis(data.get('at'))
    except (ValueError, OverflowError):
        return None
    result = {key: data[key] for key in ('event', 'commandId', 'at', 'operation', 'durationMs')}
    for key in TEXT_FIELDS:
        if isinstance(data.get(key), str) and IDENTIFIER.fullmatch(data[key]):
            result[key] = data[key]
    for key in NUMBER_FIELDS:
        if type(data.get(key)) is int and abs(data[key]) < 10**12:
            result[key] = data[key]
    for key, allowed in [('transactionType', ('IF', 'IR')), ('outcome', ('ok', 'error'))]:
        if data.get(key) in allowed:
            result[key] = data[key]
    path = str(data.get('path', '')).split('?', 1)[0].split('#', 1)[0]
    if re.fullmatch(r'/(?:services/rest/|app/site/hosting/)[A-Za-z0-9_./!-]{1,220}', path):
        result['path'] = path
    return result


def parse_line(line):
    if len(line) > MAX_LINE:
        return None
    stamp = docker_stamp(line)
    if not stamp:
        return None
    try:
        data = clean_event(json.loads(line.partition(' ')[2]))
    except (ValueError, RecursionError):
        return None
    return {'docker_at': stamp, 'event': data} if data else None


class Store:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Create privately before SQLite opens the file; never chmod its parent.
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.fchmod(descriptor, 0o600)
        os.close(descriptor)
        self.db = sqlite3.connect(path, timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS events (
              hash TEXT PRIMARY KEY, container TEXT NOT NULL, docker_at TEXT NOT NULL,
              command_id TEXT NOT NULL, at_ms REAL NOT NULL, event_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS command_index ON events(command_id, at_ms);
            CREATE INDEX IF NOT EXISTS time_index ON events(at_ms);
            CREATE TABLE IF NOT EXISTS cursors (container TEXT PRIMARY KEY, stamp TEXT NOT NULL);
        ''')

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        try:
            self.db.commit()
        finally:
            self.db.close()

    def ingest(self, container, line):
        if not IDENTIFIER.fullmatch(container):
            raise ValueError('Invalid container identifier')
        parsed = parse_line(line)
        stamp = docker_stamp(line[:MAX_LINE])
        if stamp:
            self.db.execute('''INSERT INTO cursors VALUES (?,?) ON CONFLICT(container)
                DO UPDATE SET stamp=MAX(stamp,excluded.stamp)''', (container, stamp))
        if not parsed:
            return 0
        data = parsed['event']
        encoded = json.dumps(data, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(f'{container}\n{stamp}\n{encoded}'.encode()).hexdigest()
        result = self.db.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)',
                                 (digest, container, stamp, data['commandId'], millis(data['at']), encoded))
        return result.rowcount

    def checkpoint(self, container):
        row = self.db.execute('SELECT stamp FROM cursors WHERE container=?', (container,)).fetchone()
        return row[0] if row else None

    def events(self, since=None, until=None, command_id=None):
        # Select commands by window, then include all retained spans for each.
        where, args = [], []
        for option, operator in [(since, '>='), (until, '<')]:
            if option:
                where.append(f'at_ms {operator} ?')
                args.append(millis(option))
        if command_id:
            where.append('command_id=?')
            args.append(command_id)
        clause = ' AND '.join(where) or '1=1'
        rows = self.db.execute(f'''SELECT event_json FROM events WHERE command_id IN
            (SELECT DISTINCT command_id FROM events WHERE {clause}) ORDER BY at_ms''', args)
        return [json.loads(row[0]) for row in rows]


def interval(data):
    end = millis(data['at'])
    return end - data['durationMs'], end


def union_ms(intervals):
    total, end = 0, -math.inf
    for start, stop in sorted(intervals):
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return round(total, 3)


def grouped(events, field):
    keys = sorted({data[field] for data in events if field in data})
    return {key: {'count': sum(data.get(field) == key for data in events),
                  'wallMs': union_ms(interval(data) for data in events if data.get(field) == key)}
            for key in keys}


def summarize(events):
    if not events:
        return {}
    spans = [interval(data) for data in events]
    queue = [interval(data) for data in events if data['operation'] == 'netsuite.queue']
    http = [interval(data) for data in events if data['operation'] == 'netsuite.http']
    auth = [interval(data) for data in events if data['operation'] == 'netsuite.auth']
    first, last = min(start for start, _ in spans), max(end for _, end in spans)
    elapsed = round(last - first, 3)
    operations = grouped(events, 'operation')
    warnings = [f'Missing {name}; command coverage may be incomplete.' for name in
                ('posting.admission', 'posting.finalization') if name not in operations]
    if any(data.get('outcome') == 'error' for data in events):
        warnings.append('At least one timed operation failed; elapsed is not proof of a successful posting.')
    return {'commandId': events[0]['commandId'],
            'transactionType': next((data['transactionType'] for data in events if 'transactionType' in data), None),
            'sourceNetSuiteIds': sorted({data['sourceNetSuiteId'] for data in events if 'sourceNetSuiteId' in data}),
            'firstAt': timestamp(first / 1000), 'lastAt': timestamp(last / 1000),
            'observedElapsedMs': elapsed, 'queueMs': union_ms(queue), 'httpMs': union_ms(http),
            'authMs': union_ms(auth), 'remoteOrQueueMs': union_ms(queue + http),
            'queueHttpOverlapMs': round(union_ms(queue) + union_ms(http) - union_ms(queue + http), 3),
            'unattributedMs': round(max(0, elapsed - union_ms(queue + http + auth)), 3),
            'operations': operations, 'queues': grouped(events, 'queue'), 'paths': grouped(events, 'path'),
            'warnings': warnings}


def report(events):
    commands = {}
    for data in events:
        commands.setdefault(data['commandId'], []).append(data)
    summaries = sorted((summarize(group) for group in commands.values()),
                       key=lambda data: data['observedElapsedMs'], reverse=True)
    stats = {}
    for kind in ('IF', 'IR'):
        values = sorted(data['observedElapsedMs'] for data in summaries if data['transactionType'] == kind)
        stats[kind] = {'count': len(values)}
        if values:
            stats[kind].update(meanMs=round(statistics.mean(values), 3), medianMs=statistics.median(values),
                               p95Ms=values[math.ceil(len(values) * .95) - 1])
    return {'stats': stats, 'commands': summaries,
            'notes': ['Observed elapsed uses completed spans only; active or missing spans are not measurable.',
                      'Stage, queue and HTTP rows overlap. Their totals must not be added together.',
                      'Unattributed time includes app work, logging gaps and retry delays; it is not a CPU measurement.',
                      'Commands with any span in the requested UTC window include all their retained spans.']}


def inspect_container(name):
    result = subprocess.run(['docker', 'inspect', '--format', '{{.Id}}', name],
                            capture_output=True, text=True, timeout=10, check=True)
    identifier = result.stdout.strip()
    if not re.fullmatch(r'[a-f0-9]{64}', identifier):
        raise ValueError('Docker did not return a container ID')
    return identifier


def bounded_lines(buffer, chunk, dropping):
    # A noisy or hostile log line cannot grow the collector's memory indefinitely.
    output = []
    for part in chunk.splitlines(keepends=True):
        complete = part.endswith(b'\n')
        if not dropping:
            buffer += part
            if len(buffer) > MAX_LINE:
                buffer, dropping = b'', True
            elif complete:
                output.append(buffer.decode('utf-8', errors='replace').rstrip('\r\n'))
                buffer = b''
        if complete and dropping:
            buffer, dropping = b'', False
    return output, buffer, dropping


def follow(store, name, identifier, since, stopped):
    process = subprocess.Popen(['docker', 'logs', '--follow', '--timestamps', '--since', since, identifier],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    buffer, dropping, next_inspect = b'', False, time.monotonic() + 5
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while not stopped():
            for key, _mask in selector.select(timeout=1):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    return
                lines, buffer, dropping = bounded_lines(buffer, chunk, dropping)
                for line in lines:
                    store.ingest(identifier, line)
            store.db.commit()
            if time.monotonic() >= next_inspect:
                if inspect_container(name) != identifier:
                    return
                next_inspect = time.monotonic() + 5
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        store.db.commit()


def collect(store, name, since):
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        stopping = True

    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, stop)
    print(json.dumps({'collector': 'started', 'container': name}), flush=True)
    while not stopping:
        try:
            identifier = inspect_container(name)
            checkpoint = store.checkpoint(identifier)
            start = timestamp(millis(checkpoint) / 1000 - 2) if checkpoint else since
            follow(store, name, identifier, start, lambda: stopping)
        except (subprocess.SubprocessError, ValueError, OSError) as error:
            # Error type only: Docker stderr and unrelated logs may contain secrets.
            print(json.dumps({'collector': 'reattaching', 'errorType': type(error).__name__}), flush=True)
        deadline = time.monotonic() + 2
        while not stopping and time.monotonic() < deadline:
            time.sleep(.2)
    print(json.dumps({'collector': 'stopped'}), flush=True)


def print_report(result, limit):
    for kind, stats in result['stats'].items():
        if stats['count']:
            print(f"{kind}: {stats['count']} commands, mean {stats['meanMs']/1000:.3f}s, "
                  f"median {stats['medianMs']/1000:.3f}s, p95 {stats['p95Ms']/1000:.3f}s observed")
        else:
            print(f'{kind}: no retained commands in this window')
    for data in result['commands'][:limit]:
        print(f"\n{data['transactionType']} {data['commandId']} source {data['sourceNetSuiteIds']}")
        print(f"  Observed {data['observedElapsedMs']/1000:.3f}s; queue {data['queueMs']/1000:.3f}s; "
              f"HTTP {data['httpMs']/1000:.3f}s; other/unattributed {data['unattributedMs']/1000:.3f}s")
        for label in ('operations', 'queues', 'paths'):
            for key, value in sorted(data[label].items(), key=lambda pair: pair[1]['wallMs'], reverse=True):
                print(f"  {label}: {key}: {value['wallMs']/1000:.3f}s ({value['count']} spans)")
        for warning in data['warnings']:
            print(f'  {warning}')
    for note in result['notes']:
        print(f'\n{note}')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', default=DEFAULT_DB)
    commands = parser.add_subparsers(dest='command', required=True)
    collector = commands.add_parser('collect')
    collector.add_argument('--container', default='mbbs-operator-app-app-1')
    collector.add_argument('--since', default=timestamp(time.time() - 86400))
    ingest = commands.add_parser('ingest', help='Read timestamped Docker logs from stdin')
    ingest.add_argument('--container', required=True)
    summary = commands.add_parser('report')
    summary.add_argument('--since')
    summary.add_argument('--until')
    summary.add_argument('--command-id')
    summary.add_argument('--json', action='store_true')
    summary.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    with Store(args.db) as store:
        if args.command == 'collect':
            millis(args.since)
            collect(store, args.container, args.since)
        elif args.command == 'ingest':
            count, buffer, dropping = 0, b'', False
            while chunk := sys.stdin.buffer.read(8192):
                lines, buffer, dropping = bounded_lines(buffer, chunk, dropping)
                count += sum(store.ingest(args.container, line) for line in lines)
                store.db.commit()
            if buffer and not dropping:
                count += store.ingest(args.container, buffer.decode('utf-8', errors='replace'))
            print(json.dumps({'inserted': count}))
        else:
            result = report(store.events(args.since, args.until, args.command_id))
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                print_report(result, max(0, args.limit))


if __name__ == '__main__':
    main()
