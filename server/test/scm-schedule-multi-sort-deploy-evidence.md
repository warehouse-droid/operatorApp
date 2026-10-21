# PO/TO Schedule deployment evidence

Deployed and verified at 2026-10-01T03:32:07.393952+00:00 on https://test.mbbsoperation.com, following the user's explicit request to deploy this change along with the PO Note change. [Acceptance spec](scm-schedule-multi-sort-deploy-spec.md). Spec approval: not obtained (autonomous deployment preparation).

The subsequent toolbar follow-up was deployed at 2026-10-01T03:45:11.883895+00:00. It removes the sort summary and compacts the toolbar to one row, preserving this release's sorting, filters and backend. The current app image is `mbbs-operator-app:special-po-mini-rows-20261001` (`sha256:f5b723bd222430ba2d21d5c3e86fb44cd96144ee0a29a42e961435fe083d5151`). [Toolbar evidence](scm-schedule-toolbar-evidence.md) records its three-asset scope and desktop checks. Read-only verification of the current app is `python3 tools/special-po-mini-rows-deploy.py verify`.

Type, Method and Drop-off filters accept multiple selections, combine choices within a column, and combine filters across columns. Saved preferences retain multiple choices and legacy selections. Column sorting displays priorities and directions and retains row drafts, selections, hidden columns and expanded details. This release layers the existing Schedule implementation over the deployed Special Request PO Note app.

| Validation | Result |
| --- | --- |
| Schedule unit checks | 16/16 pass |
| Chromium browser checks | 10/10 pass |
| Real PostgreSQL filter and preference harnesses | Pass; multiple selections, combined yards, hidden Dispatch Method filter, account/surface isolation and explicit clearing |
| Migration 248 | Runs twice successfully in isolation; seeded legacy choices backfill correctly; applied transactionally in production |
| Existing column regression mutants | 3/3 killed |
| PO Note regression suite against this exact candidate | 108 tests: 95 pass, 13 unchanged fixture failures, 0 skipped; zero new failures |
| Syntax / lint / secrets | Selected JavaScript passes syntax; zero new lint findings; scoped secret scan passes |
| Candidate integrity | Exactly six changed runtime files; whole image tree verified; production import smoke check passes; dependencies unchanged |
| Live health and static assets | Local and public health succeed; all three served Schedule assets match candidate SHA-256 values |
| Live preferences | Protected endpoint returns 401 anonymously; all three array columns and recorded migration are present |
| Note and surrounding services | PO Note source preserved; POB03976 cached Note remains `for SOB121819`; app configuration and webhook worker/database/Ollama container identities unchanged |

The 13 Note fixture failures match the previously documented baseline and reject fixtures without an active NetSuite customer. The final six-file hashes match the isolated validation source. Full checks and logs: [checks.json](../test-artifacts/scm-schedule-deploy-20261001/checks.json). No real NetSuite order was written or created for deployment verification, and fixture checks ran only in the guarded isolated database.

The first publication passed local verification but its public health read encountered `UND_ERR_CONNECT_TIMEOUT`. Automatic rollback restored the exact Note parent image and configuration while retaining the additive preference columns. After host and container public reads succeeded, the retry baseline verified the restored source tree, unchanged candidate and untouched services. Verification now retries only public GET connection timeouts up to three attempts; status, authentication and asset hash assertions are unchanged. The second publication passed with 0 public read retries. The original attempt's manifest and rollback logs are retained under `deployments/scm-schedule-multi-sort-20261001/first-attempt`.

All five active-work guards were zero before publication. Only the app was replaced; the webhook worker was not restarted by this release. Rollback uses the captured Note image and keeps the additive array columns. The full repository suite was not run; this release used the focused Schedule checks, PostgreSQL harnesses and affected Note regression suite. No new dependencies, Git commits or agents were used.

Image: `mbbs-operator-app:scm-schedule-multi-sort-20261001`. Image ID: `sha256:62aa13e40005ae0fd890cb81d3edd8dde448a999e2eb06d3fb9fd585cf6c40ec`. Runtime tree: 1172 files, SHA-256 `6481a0ab645b065e86fc7254b72afe1b65756ae81d9ce0cfad134382efba6536`.

| Selected runtime file | SHA-256 |
| --- | --- |
| `public/scm-schedule.js` | `12910280640efebf285424f4ae6a98406023d9162f4405e6763e7c3183ff77b2` |
| `public/scm-schedule.html` | `f1778e231c0db83098ef311c17d154c2c971fbcb711caa7db86fcaf97a6f6d2d` |
| `public/dispatch.css` | `f974d8acb265187c34e444cb9e991fc746b716e62d39d21d698c33000ebaf08b` |
| `src/dispatch-repository.js` | `29636618e2c3824c84bdc318625c19f5299efc46aea4eaa7e106c6476b00fff5` |
| `src/scm-schedule-preference-repository.js` | `4d327efdccebe0b7314688603ab6ba654118483dfe29430472503d8c9d7a3811` |
| `migrations/248_scm_schedule_multi_filters.sql` | `03da83cf9aaaa5757a88e333d7dc91ddbc1ee6b7df17059c38126c1214133380` |

Tools: node v20.20.2, eslint 10.8.0, fast-check 4.9.0, @playwright/test 1.62.1.

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

Generated: 2026-10-01T04:01:31.415564+00:00.
