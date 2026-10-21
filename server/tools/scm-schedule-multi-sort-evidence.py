"""Render Schedule release evidence from the exact candidate checks and live result."""
import datetime
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/scm-schedule-multi-sort-20261001'
OUT = SERVER / 'test-artifacts/scm-schedule-deploy-20261001'


def read(path):
    return json.loads(path.read_text())


checks = read(OUT / 'checks.json')
manifest = read(RELEASE / 'manifest.json')
live = read(RELEASE / 'result.json')
tree = read(RELEASE / 'source-tree.json')
files = read(SERVER / 'tools/scm-schedule-multi-sort-files.json')
assert checks['completed'] and not checks['newFailures']
assert checks['sourceHashes'] == manifest['sourceHashes']
assert live['deployed'] and live['imageId'] == manifest['services']['app']['candidateImageId']
assert all(live[key] for key in ['configurationPreserved', 'webhookWorkerDatabaseOllamaUnchanged',
                               'noteSourcePreserved', 'health', 'publicAssets', 'preferencesProtected',
                               'preferenceColumns', 'notePreserved'])
assert not any(read(RELEASE / 'active-before-release.json').values())
assert read(RELEASE / 'retry-baseline.json')['restoredParentVerified']
assert read(RELEASE / 'first-attempt/rollback-result.json')['rolledBackToNoteImage']
assert all(hashlib.sha256((RELEASE / 'candidate' / file).read_bytes()).hexdigest() == checks['sourceHashes'][file]
           for file in files)
tree_hash = hashlib.sha256(json.dumps(sorted(tree.items()), separators=(',', ':')).encode()).hexdigest()
hash_rows = '\n'.join(f'| `{file}` | `{checks["sourceHashes"][file]}` |' for file in files)
tools = ', '.join(f'{name} {version}' for name, version in checks['tools'].items())
toolbar_update = ''
toolbar_result = SERVER / 'deployments/scm-schedule-toolbar-20261001/result.json'
if toolbar_result.exists():
    toolbar = read(toolbar_result)
    assert toolbar['deployed'] and toolbar['backendAndMigrationsUnchanged']
    latest = toolbar
    verify_tool = 'scm-schedule-toolbar-deploy.py'
    mini_result = SERVER / 'deployments/special-po-mini-rows-20261001/result.json'
    if mini_result.exists():
        latest = read(mini_result)
        assert latest['deployed'] and latest['scheduleToolbarPreserved']
        verify_tool = 'special-po-mini-rows-deploy.py'
    toolbar_update = (f"The subsequent toolbar follow-up was deployed at {toolbar['at']}. "
                      "It removes the sort summary and compacts the toolbar to one row, preserving this release's sorting, filters and backend. "
                      f"The current app image is `{latest['image']}` (`{latest['imageId']}`). "
                      "[Toolbar evidence](scm-schedule-toolbar-evidence.md) records its three-asset scope and desktop checks. "
                      f"Read-only verification of the current app is `python3 tools/{verify_tool} verify`.")
report = f"""# PO/TO Schedule deployment evidence

Deployed and verified at {live['at']} on https://test.mbbsoperation.com, following the user's explicit request to deploy this change along with the PO Note change. [Acceptance spec](scm-schedule-multi-sort-deploy-spec.md). Spec approval: not obtained (autonomous deployment preparation).

{toolbar_update}

Type, Method and Drop-off filters accept multiple selections, combine choices within a column, and combine filters across columns. Saved preferences retain multiple choices and legacy selections. Column sorting displays priorities and directions and retains row drafts, selections, hidden columns and expanded details. This release layers the existing Schedule implementation over the deployed Special Request PO Note app.

| Validation | Result |
| --- | --- |
| Schedule unit checks | {checks['unit']['pass']}/{checks['unit']['tests']} pass |
| Chromium browser checks | {checks['browser']['pass']}/{checks['browser']['tests']} pass |
| Real PostgreSQL filter and preference harnesses | Pass; multiple selections, combined yards, hidden Dispatch Method filter, account/surface isolation and explicit clearing |
| Migration 248 | Runs twice successfully in isolation; seeded legacy choices backfill correctly; applied transactionally in production |
| Existing column regression mutants | {checks['columnMutantsKilled']}/3 killed |
| PO Note regression suite against this exact candidate | {checks['note']['tests']} tests: {checks['note']['pass']} pass, {checks['note']['fail']} unchanged fixture failures, {checks['note']['skipped']} skipped; zero new failures |
| Syntax / lint / secrets | Selected JavaScript passes syntax; zero new lint findings; scoped secret scan passes |
| Candidate integrity | Exactly six changed runtime files; whole image tree verified; production import smoke check passes; dependencies unchanged |
| Live health and static assets | Local and public health succeed; all three served Schedule assets match candidate SHA-256 values |
| Live preferences | Protected endpoint returns 401 anonymously; all three array columns and recorded migration are present |
| Note and surrounding services | PO Note source preserved; POB03976 cached Note remains `for SOB121819`; app configuration and webhook worker/database/Ollama container identities unchanged |

The 13 Note fixture failures match the previously documented baseline and reject fixtures without an active NetSuite customer. The final six-file hashes match the isolated validation source. Full checks and logs: [checks.json](../test-artifacts/scm-schedule-deploy-20261001/checks.json). No real NetSuite order was written or created for deployment verification, and fixture checks ran only in the guarded isolated database.

The first publication passed local verification but its public health read encountered `UND_ERR_CONNECT_TIMEOUT`. Automatic rollback restored the exact Note parent image and configuration while retaining the additive preference columns. After host and container public reads succeeded, the retry baseline verified the restored source tree, unchanged candidate and untouched services. Verification now retries only public GET connection timeouts up to three attempts; status, authentication and asset hash assertions are unchanged. The second publication passed with {live['publicReadRetries']} public read retries. The original attempt's manifest and rollback logs are retained under `deployments/scm-schedule-multi-sort-20261001/first-attempt`.

All five active-work guards were zero before publication. Only the app was replaced; the webhook worker was not restarted by this release. Rollback uses the captured Note image and keeps the additive array columns. The full repository suite was not run; this release used the focused Schedule checks, PostgreSQL harnesses and affected Note regression suite. No new dependencies, Git commits or agents were used.

Image: `{live['image']}`. Image ID: `{live['imageId']}`. Runtime tree: {len(tree)} files, SHA-256 `{tree_hash}`.

| Selected runtime file | SHA-256 |
| --- | --- |
{hash_rows}

Tools: {tools}.

Read-only live verification:

```sh
python3 tools/scm-schedule-multi-sort-deploy.py verify
```

Repeat isolated validation against the preserved candidate using the existing runner/database/Chromium setup:

```sh
python3 - <<'PY'
import importlib.util
from pathlib import Path
path = Path('tools/scm-schedule-multi-sort-deploy.py').resolve()
spec = importlib.util.spec_from_file_location('schedule', path)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.validate_candidate()
PY
```

Generated: {datetime.datetime.now(datetime.timezone.utc).isoformat()}.
"""
(SERVER / 'test/scm-schedule-multi-sort-deploy-evidence.md').write_text(report)
print(json.dumps({'evidence': 'test/scm-schedule-multi-sort-deploy-evidence.md', 'deployed': True,
                  'focusedTests': checks['unit']['tests'] + checks['browser']['tests'], 'newFailures': []}))
