# SN1400333 receiving deployment — 2026-09-15

## Result

Deployed the user's explicitly authorized receiving correction to the app and
webhook worker. Cutover started at **23:46:18 UTC** and both services passed
verification at **23:46:26 UTC**. Both have zero restarts.

- Release: `mbbs-operator-app:sn1400333-receiving-20260915-v1`
- Image ID: `sha256:a5d846bafecb1ea26e7e960c8d8f25a52dc05600ff08461a44387f4fd6e62989`
- Prior image: `sha256:ae0c3c65519eb3ee48082b974bb5403fe57914d92bab2fce7144a9ef976c8f4c`
- Rollback tag: `mbbs-operator-app:rollback-sn1400333-20260915`
- Runtime changes: `src/operator-netsuite-posting-domain.js` and
  `src/operator-netsuite-posting-targets.js`.

The new image is based on the previously running image. A hash comparison of
**898 packaged files** found **exactly these two differences**. The deployed
files in both services match the tested source manifest. Environment values and
files, mounts, ports, service commands and users were preserved. Database and
Ollama container identities/start times are unchanged. No migration ran.

## Verification

| Check | Result |
| --- | --- |
| Candidate-source contract tests | **59 passed, 0 failed**, with network disabled |
| Prior full-suite evidence | Source hashes match; 2,472 passed, 2 existing failures, 1 skipped; zero new failures |
| Prior focused/coverage/mutation evidence | Source hashes match; 66 tests passed; 16/16 changed lines; 7/7 faults caught |
| App readiness | Healthy; `/health` returns 200 and `ok:true` |
| Worker readiness | Startup message confirmed; running with zero restarts |
| Public health and Operator page | Both HTTP 200 |
| Anonymous receiving API | HTTP 401, Login required |
| Active jobs at cutover | Zero in-progress Operator postings and zero running webhook jobs |
| NetSuite writes performed | **None** |

At **23:47:38 UTC**, the read-only incident replay executed against the running
app's actual deployed modules and current source data. It confirmed:

- Source: **POB03658 / 936958**.
- Memo: **SN1400333**.
- Selected parent lines: **15:1305.6, 18:629.46, 23:930, 38:32**, all at location 1.
- Total payload lines: **34**, with the five completed parent lines omitted.
- No receipt found under the original failed request's external ID.

The split still contains its original four lines. Other open parent lines remain
explicitly deselected. No receipt was submitted or retried, so actual NetSuite
acceptance and the exact cause of the original 400 remain unconfirmed.

Reopen SN1400333's receiving confirmation before retrying, so it gets a fresh
request ID and the corrected payload. The old failed command remains unchanged.

## Reproducibility and rollback

Preparation and cutover commands, from `server/`:

```sh
sudo -n python3 tools/sn1400333-receiving-deploy.py prepare
sudo -n python3 tools/sn1400333-receiving-deploy.py apply
```

The preparation gate intentionally refuses a different live baseline image or
untested source. The script builds without network access, checks packaged
differences, runs candidate-source tests and preserves the prior image. Cutover
verifies configuration and source hashes, and restores the prior image if its
health/configuration verification fails. No rollback was needed.

Private deployment directory:
`/home/ubuntu/operatorapp-deploy-backups/sn1400333-20260915/`.
It contains the image build inputs, manifest, container/configuration snapshots,
release and rollback Compose overrides, candidate test output, startup logs,
HTTP checks and deployed read-only replay. Original Compose file paths are
retained in `containers.before.private.json`; the rollback override sets both
application services to the retained prior image. Rollback recreates only app
and webhook-worker, with `--no-deps --no-build --pull never`.

The first public probe with Python's default user agent returned HTTP 403.
Repeating with a browser user agent returned the expected 200/200/401 responses;
no server or edge configuration was changed.

[Implementation evidence](sn1400333-receiving-evidence.md) and
[approved deployment scope](sn1400333-receiving-spec.md) record the boundaries.
