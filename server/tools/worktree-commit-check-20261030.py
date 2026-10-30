"""Screen the staged release without printing or persisting credential values."""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / 'server/test/whole-worktree-deployment-20261030-secret-check.json'
SECRET_KEY = re.compile(r'password|secret|token|private.?key|api.?key|database.?url', re.I)
PROVIDER = re.compile(rb'\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b')
PRIVATE_KEY = re.compile(rb'-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----')
ASSIGNMENT = re.compile(r'\b[A-Za-z0-9_-]*(?:password|secret|token|credential|private[_-]?key|api[_-]?key|database[_-]?url)[A-Za-z0-9_-]*\s*(?::|=)\s*([\"\x27])([^\"\x27]*)\1', re.I)


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, stderr=subprocess.PIPE)


def live_secret_values():
    values = set()
    rows = json.loads(output('docker', 'inspect', 'mbbs-operator-app-app-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1'))
    for row in rows:
        for entry in row['Config']['Env']:
            key, _, value = entry.partition('=')
            if SECRET_KEY.search(key) and len(value) >= 8:
                values.add(value.encode())
    for name in ['.env', '.env.old']:
        path = ROOT / 'docker/env' / name
        if not path.exists(): continue
        for line in path.read_text().splitlines():
            key, separator, value = line.partition('=')
            if separator and SECRET_KEY.search(key) and not key.lstrip().startswith('#'):
                value = value.strip().strip('\"\x27')
                if len(value) >= 8: values.add(value.encode())
    # Explicit placeholder values are not live credentials.
    return {v for v in values if not re.search(rb'example|placeholder|change-me|dummy|localhost|127\.0\.0\.1', v, re.I)}


def main():
    secrets = live_secret_values()
    names = [p for p in output('git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR').decode().split('\0') if p]
    findings, reviewed = [], []
    inspected = 0
    manifest = {}

    def scan(name, data):
        nonlocal inspected
        inspected += 1
        for value in secrets:
            if value in data:
                findings.append({'file': name, 'kind': 'matches_live_credential'})
                break
        for label, pattern in [('provider_token', PROVIDER), ('private_key', PRIVATE_KEY)]:
            for match in pattern.finditer(data):
                line = data[:match.start()].count(b'\n') + 1
                content = data.decode(errors='replace').splitlines()[line - 1]
                findings.append({'file': name, 'line': line, 'kind': label,
                                 'lineSha256': hashlib.sha256(content.encode()).hexdigest()})
        if b'\0' in data[:8192]: return
        for number, line in enumerate(data.decode(errors='replace').splitlines(), 1):
            for match in ASSIGNMENT.finditer(line):
                value = match[2]
                if len(value) < 12 or re.search(r'test|fixture|example|dummy|fake|invalid|placeholder|localhost|127\.0\.0\.1|@db:|process\.env|configured|harness|must-not|do-not|synthetic|[${}]', value, re.I):
                    continue
                item = {'file': name, 'line': number, 'kind': 'credential_like_literal',
                        'lineSha256': hashlib.sha256(line.encode()).hexdigest()}
                if 'secret-scan: allow' in line:
                    reviewed.append({**item, 'reason': 'Existing explicit non-secret annotation'})
                elif '/test/' in '/' + name and (value.endswith('-token') or re.fullmatch(r'[a-f0-9-]{36}', value)
                    or re.fullmatch(r'[a-z]+(?:-[a-z]+){1,6}[0-9]*', value)):
                    reviewed.append({**item, 'reason': 'Human-readable synthetic test fixture or UUID'})
                else:
                    findings.append(item)

    for name in names:
        data = output('git', 'show', ':' + name)
        if name != str(REPORT.relative_to(ROOT)):
            manifest[name] = hashlib.sha256(data).hexdigest()
        scan(name, data)
        if name.endswith(('.tar.gz', '.tgz')):
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                for member in archive:
                    if member.isfile() and member.size <= 8_000_000:
                        scan(name + '::' + member.name, archive.extractfile(member).read())
        elif name.endswith('.docx'):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for member in archive.infolist():
                    if member.file_size <= 8_000_000:
                        scan(name + '::' + member.filename, archive.read(member))
    review_path = ROOT / 'server/tools/worktree-commit-secret-review-20261030.json'
    explicit = json.loads(review_path.read_text())
    def same_finding(left, right):
        return all(left.get(key) == right.get(key) for key in ['file', 'line', 'kind', 'lineSha256'])
    unresolved = []
    for finding in findings:
        match = next((item for item in explicit if same_finding(finding, item)), None)
        if match is None: unresolved.append(finding)
        else: reviewed.append(match)
    findings = unresolved
    report = {'passed': not findings, 'stagedFiles': len(names), 'filesIncludingArchiveMembers': inspected,
              'stagedContentHash': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
              'liveCredentialValuesChecked': len(secrets), 'findings': findings,
              'reviewedNonSecretLiterals': reviewed}
    REPORT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'reviewedNonSecretLiterals'}))
    if findings: raise SystemExit(1)


if __name__ == '__main__':
    main()
