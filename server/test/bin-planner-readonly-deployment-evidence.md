# Read-only planner deployment — 2026-09-27

Deployed and live verification completed at 2026-09-27T08:07:05.637445+00:00.
Image: `sha256:fc682f9ba4ac6876b67af9ea68f59308a3a8acb8e7de75336aa1bd8dec52052c`.
Rollback: `mbbs-operator-app:rollback-bin-readonly-ui-20260927`.

Five UI files were overlaid on the previous live image. All 1104
runtime files match the scoped candidate. Service configuration is preserved;
app and worker are healthy with zero restarts; database and other dependencies
are unchanged. No migrations were applied. No dispatch editor or in-flight
operation was active at cutover.

Fourteen local/public asset responses matched their deployed hashes. BIN planning,
Dispatch bootstrap and shared date lease endpoints returned 200 locally and
publicly; anonymous requests remained 401. The diagnostic login/session was
removed, no edit lease was acquired, and the daily plan snapshot was unchanged.

The private backup was validated: 398985694 bytes,
SHA-256 `035833950f898fab2d60ee27e8e1581bae801aab2bc24e7d068a6fe788c4a53c`. Candidate startup and rollback were rehearsed before cutover.

[Test evidence](bin-planner-readonly-evidence.md) records exact-UI browser
comparisons, both truck-switch directions, 65 BIN tests, 155 compatibility tests,
34 additional frontend checks, repeat tests, five killed mutants, and the four
unchanged Dispatch suite failures. Full receipt and release artifacts are under
`test-artifacts/bin-planner-readonly-release-20260927/`.
