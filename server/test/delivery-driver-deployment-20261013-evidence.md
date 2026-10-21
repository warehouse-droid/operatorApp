# Delivery request and Driver PWA deployment

The later [conversation-only correction](delivery-conversation-only-20261013-evidence.md)
is now live and preserves every Driver runtime hash. The original combined and
estimate follow-up deployment record below is retained as historical evidence.

The user explicitly authorized deployment with "deploy", then "deploy the driver
PWA as well". Both updates are live. The final application image is
`mbbs-operator-app:delivery-driver-est-mainline-20261013`, image ID
`sha256:62cd64719d80aae3a88b0776d94adde3808c41e0572296251d32932432c41bea`.
The combined release completed at `2026-10-13T22:03:51.836993+00:00`; the
estimate-only follow-up completed at `2026-10-13T22:21:47.771718+00:00`.

The delivery update adds the Sales/Dispatch conversation after Remarks, independent
replies and alerts, whole-number Full/Loose POS quantities, BIN aggregate selection
with Yard quantities, optional EST attachment/preview, and linked SO previews.
The Driver update adds measured upload progress, bounded waits, retained evidence
for retries, lost-save reconciliation, and authenticated persistent failure records.
Driver assets use `20261013-driver-upload-v1`, shell cache v45, and the existing
logical protocol version.

| Verification | Result |
| --- | --- |
| Final exact-image delivery regression and acceptance checks | 164/164 tests passed across 16 isolated files; no skips |
| Delivery static checks | Types and focused lint passed with zero warnings |
| Changed delivery executable lines | 331/331 executed using Node and browser coverage |
| Delivery mutation checks | 9/9 killed; three quantity mutations also killed by generated properties alone |
| Exact combined-image Driver unit/property/HTTP checks | 54/54 passed; syntax, focused lint, and diagnostic types passed |
| Driver mobile fault workflows | 8/8 passed across Chromium/WebKit; zero retries or flaky tests |
| Live EST preview | Read-only preview succeeded with two item lines, original unit labels, and finite total |
| Live linked SO preview | Original NetSuite PDF returned, 1095519 bytes, valid PDF signature |
| Local and public application health | HTTP 200 |
| Changed public assets | All nine hashes match the release at both origins |
| Private delivery metadata and Driver diagnostics | Anonymous requests returned 401 |
| Driver audit migration | Unique index built concurrently and verified valid; migration 282 recorded after success |
| Production services | App, database, and Ollama healthy; webhook worker running |
| Host cleanup | Both docker ps and docker ps -a contain only the four production containers; zero task test networks or volumes |

The runtime overlay was applied to the latest live image, preserving intervening
production releases. The combined overlay contains 19 scoped files; the follow-up
changes only `src/delivery-request-documents.js`. All 1364 runtime source, asset,
and migration files were compared against the captured source tree. Configuration,
database, webhook worker, and Ollama were preserved. Application operations were
checked idle before each cutover. Both releases retain exact rollback images and
Compose configuration. Production data and operational audit records were outside
test cleanup.

Live verification found two NetSuite data-format differences: estimate yards are
stored on the main transaction line, and expanded item units can be internal
numeric IDs. New regressions failed before the corrections. Estimate lookup now
prefers the header yard and falls back to the mainline, retaining requesting-yard
authorization. Preview resolves numeric units to original NetSuite labels through
a read-only query and reports unresolved labels as a visible error. The final
delivery suite and mutation checks ran again against the exact corrected candidate.
No production request or NetSuite transaction was created or modified by checks.

The initial Driver staging anchor and early diagnostic-parser omission were
corrected before deployment. Their failed candidates and logs were retained; the
HTTP assertion requiring 413 for oversized diagnostics was unchanged. The final
runtime includes the dedicated 16 KB parser. The historical replay harness was
excluded. Earlier Driver baseline failures and physical-device limitations remain
documented in the [Driver evidence](driver-upload-reliability-evidence.md).

Tests used the repository's isolated Compose configuration, `mbbs-tests.slice`,
bounded memory/CPU/PID/tmpfs limits, init, disposable labels, and teardown registered
before launch. Containers, disposable database storage, and unused test networks
were removed after every run, including expected failing regression runs. Logs,
source captures, traces, screenshots, coverage, and mutation evidence were retained.

Evidence locations, relative to the repository root:

- `server/deployments/delivery-driver-20261013/`: combined manifest, scoped patch,
  source capture, image/import checks, configuration checks, concurrent migration,
  deployment result, and rollback configuration.
- `server/deployments/delivery-est-mainline-20261013/`: final candidate source,
  manifest, runtime hashes, idle-operation check, deployment result, live EST/SO
  verification, and rollback configuration.
- `server/test-artifacts/delivery-driver-release-20261013/est-final/`: final
  delivery source hashes, shuffled suite order, types/lint, 164-test run, 331-line
  coverage, nine mutation results, browser evidence, and teardown.
- `server/test-artifacts/delivery-driver-release-20261013/driver/`: exact combined
  Driver source hashes, 54-test run, eight mobile workflows, and teardown.
- `server/test-artifacts/delivery-driver-release-20261013/final-host/`: final
  public/local asset and access checks, index validity, production health,
  docker ps/ps -a, and zero disposable-resource counts.

Behavior-to-test details are in the
[delivery evidence](delivery-request-enhancements-20261013-evidence.md) and
[Driver evidence](driver-upload-reliability-evidence.md).
