# Retain successful Operator Item Receipt confirmation

Spec approval: not obtained (autonomous run). The user authorized ensuring the
IR is shown after successful NetSuite posting. Tier 3: receipt recovery must
never submit inventory a second time or expose another operator's records.

Acceptance scenarios:

1. A successful receipt displays its recorded IR number until the operator
   deliberately selects Back to Receiving. Background events do not dismiss it.
2. Reloading during posting or after completion restores the same job and IR,
   including a PO searched from another receiving menu.
3. An older screen with no receipt journal can recover its selected order's
   existing server-side job after an app update, using reads only. The recorded
   SN1401278 / IR14813 result must display in the incident replay.
4. Receipt recovery uses the exact order, actual order type, current operator,
   and authorized yard. Failed or unrelated jobs cannot appear as successful.
5. An interrupted recovery remains visibly pending and can retry the lookup
   without another receipt POST. Late responses cannot replace a newer screen.
6. Known IR references stay visible while local verification needs attention;
   the screen distinguishes receipt creation from completed local verification.
7. Acknowledgement clears recovery state; a fresh partial receipt can proceed.
   New ordinary receiving views must not redisplay previously acknowledged jobs.
8. Automatic service-worker reload is deferred while receiving is in progress
   or the receipt awaits acknowledgement, then applied after acknowledgement.
9. Local-only and CO receiving, photo submission, existing receiving searches,
   and existing posting-job response contracts retain their behavior.
10. Receipt text remains escaped; invalid/unavailable local storage cannot
    fabricate receipt completion. Recovery does not change NetSuite records,
    receipt quantities, posting claims, or existing server-side completion rules.

Failure model and checks: duplicate submission (POST counts and recovery
properties); stale/late status responses (deferred browser/unit cases);
legacy missing journal (archived client upgrade replay); interrupted lookup
(network-failure replay); misleading completion (failed/attention cases);
cross-account/yard disclosure (real database and authenticated route checks);
unbounded recovery data (one current receipt marker and existing per-order
journal); update interruption (real browser event handler checks).

Setup: reuse the installed Node, PostgreSQL, Chromium, node:test, fast-check,
ESLint, TypeScript, and V8 coverage in the existing test image. Add no
dependencies, migrations, or commits. Capture the current source baseline and
run the project suite in an isolated database. Add focused tests, a reproducible
verification entry point, browser traces, changed-line coverage, manual
mutations, and an evidence report. Compare full-suite and static results with
the captured baseline, preserving unrelated workspace edits. Prepare a scoped
release from the current running image and verify its exact files before a
reversible application rollout. Live receipt verification is read-only.

Release contract: version the changed operator script and worker cache as
`20260925-receipt-confirmation-v1`; retain the unchanged refresh helper version.
Deferred updates after local CO acknowledgement must preserve its existing
navigation to packed Transfer Orders in Delivery.
