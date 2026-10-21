# PO Remark, Note and special-request mini bar

Deployed on 2026-09-30. PO Split and the special-request mini bar now show
the PO remark and Note, with shared SCM edits. The duplicate wide PO reference
form is removed, and the mini bar appears above Line responses.

Remark defaults to the current PO memo; a local SCM override takes precedence.
Leaving a mapped remark unchanged preserves its source, and clearing an override
restores the PO remark. Note uses the shared schedule note, with current PO
instructions as the source fallback. SPREQ-000017 / POB03976 maps the existing
remark “Pickering Yard - Unilock” and Note “Mon-Fri”.

The follow-up also makes routing use the current packing reference for loading,
saving and opening PO Split. A PO missing from the catalog receives its mapped
text fields on the first detail response.

| Verification | Result |
| --- | --- |
| Final affected unit, property, database and browser suites | 34/34 passed; zero skipped |
| Actual release candidate | 34/34 passed |
| Changed JavaScript syntax | Passed |
| Types and lint compared with captured baseline | Zero new findings |
| Shared dispatch-note rollback harness | Passed |
| Runtime, tests and release-helper secret scans | Passed |
| Production dependency import | Passed |
| Live health, public assets and 1,167 runtime source hashes | Passed |
| Live SPREQ-000017 mapping and PALLET attention status | Remark and Note mapped; attention remains false |

An additional older shared-remark harness retains its pre-existing
`AssertionError [ERR_ASSERTION]: Missing expected rejection.` Both captured
pre-change sources and the candidate reproduce it. Its missing existing
first-seen schema migration was applied only inside its rollback transaction;
the behavioral assertions were retained. The previous unit assertion that POs
omit their memo was updated to match the user's requested PO remark mapping.

Browser checks cover shared saves across both screens, failed-save drafts,
HTML escaping, mobile overflow, mini-bar position, a single packing reference
field, renamed references and late responses from another request. Database
checks cover local edits, clearing overrides, fresh source values, unchanged PO
source fields and stale revision rejection. Existing PALLET tests also pass.

Reproduce the final isolated checks from `server/`:

```sh
sh tools/scm-po-text-refs-verify.sh
```

Recorded tools: Node v20.20.2, TypeScript 7.0.2, ESLint 10.8.0 and Playwright
1.62.1. No dependencies or production migrations were added. The full repository
suite was not run. Verification performed no live schedule save or NetSuite
write.

The final image is `mbbs-operator-app:scm-po-text-refs-20260930`, image ID
`sha256:805770c65209f2ef0a7c76a4dac395284a230508680cbaefd3d6ab7ee1355dc0`.
The runtime tree hash is
`f506137b23d152be4f00ef7f7b34ea03a72033e44dfc32c7a3227a3b9fb862b4`
(SHA-256 of sorted-key Python JSON serialization of `source-tree.json`).
App configuration, worker and dependencies were preserved; rollback images
are recorded with each scoped release.

[Final checks](../test-artifacts/scm-po-text-refs-20260930/checks.json),
[initial layout release](../deployments/scm-po-text-20260930/result.json), and
[final deployment verification](../deployments/scm-po-text-refs-20260930/result.json).
