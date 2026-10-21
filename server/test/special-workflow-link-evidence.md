# SCM review synchronization and native SO–PO linkage

Spec approval: not obtained (autonomous run). The user explicitly confirmed
that SCM's reviewed quantity/UOM/description should correct the SO first and
then update/create the PO. Tier 3: financial records, concurrent webhooks and
duplicate prevention. See [the append-only specification](special-workflow-description-race-spec.md).

The workflow now records the reviewed SO quantity, native UOM and description
before creating/updating the native Special Order PO. Sales unit prices and PO
purchase costs remain separate. Exact line identities, complete original or
reviewed tuples, ownership of the active operation, approval and closed/received/
billed checks prevent arbitrary reconciliation or duplicate creation. Final-link
promise failures now reach the attention handler instead of remaining stuck in
`creating`.

SPREQ-000007 already had SO SOB121380 (1017068) and PO POB03934 (1017168) when
investigation began. The existing PO was recovered into the app using its unique
case marker, with no new NetSuite order. Both records contain 500 PC of item 2055
with description `Unilock Ltd Endura Coping Lineo Buff 123test`; the sales rate is
17 and purchase cost is 5. The SO's pallet line remains 11 EACH at 40.
SPREQ-000006's complete app-case fingerprint remains unchanged.

The user's example is actually SOB121261 (1013211) / POB03931 (1015335). Readback
confirmed `SpecOrd` transaction-line links, SO `createdPo`, and PO `createdFrom`.
NetSuite's account schema exposes `createPo=SpecOrd`, `poVendor` and `poRate`.
[Oracle's documented Special Order flow](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2409296.html)
creates a linked PO when the marked SO is saved/approved; the implementation
uses that flow. It does not attempt an unsupported SO-to-PO transform.

A bounded attempt to attach existing POB03934 using PO source-line fields was
rejected with HTTP 400 `NONEXISTENT_FIELD` for `orderLine`. Full commercial
readback confirmed no change. POB03934 remains app-linked and standalone in
NetSuite. No cancellation, replacement, duplicate PO or new live native PO was
created for testing. Native creation is verified with the real adapters and
service against simulated REST responses, account-specific schema evidence,
and real PostgreSQL transactions; a live native creation remains unexercised.

Verification command: `bash server/tools/special-workflow-link-check.sh`.
The runner requires the existing `mbbs-special-review-runner` and isolated
`mbbs-special-review-db` (`MBT_TEST_ISOLATED=1`, database `mbt_verify`). Versions,
source hashes, captured deployed baseline, exact diff, all logs and mutation
results are under `server/test-artifacts/special-workflow-review/so-po-native/`.
No dependencies, migrations or commits were added. Existing unrelated worktree
changes are preserved.

| Layer | Result / scope |
| --- | --- |
| Full Special Item suite | 189 tests; 188 pass, one known baseline failure, zero new failures |
| Changed runtime lines | 320/320 covered; one explanatory UI sentence reviewed separately |
| Static checks | Strict checked-JS for both adapters; syntax for every deployed file; lint with zero warnings |
| Mutation | 8/8 manual mutants killed; six rerun against properties alone; ownership/finalization mutants killed by repository/service tests |
| Properties | Seeds 26092031/32/33; identity, whole reviewed tuple, preserved prices/ancillary lines and idempotent native creation |
| Suite health | All 31 test files rerun in seeded shuffled order (26092034); same single baseline failure |
| Supply chain | No dependency changes; scoped source/tool secret scan passes |
| Real execution | Actual PO recovery and read-only SO/PO/marker/protected-case checks; candidate image boots/imports without network; release health and hashes verified |

The known baseline failure is `Dispatch save and restore require a route and
Via Yard receipt without weakening snapshots`, with
`function dispatch_direct_to_has_residual(bigint) does not exist`. The isolated
review database lacks the unrelated Direct Ship migration. No test was skipped
or weakened to hide it. Legacy large repository/service modules are dynamically
typed; the new boundary adapters receive strict static type checking. Coverage
reports retain branch details; no claim of 100% branch coverage is made.

Behavior mapping:

- `special-workflow-description-race.test.js` (unit/integration): exact reviewed
  transitions, wrong/stopped owner, future/stale revisions, approval/closed/
  planned/external-edit guards, description/quantity/UOM updates interleaved
  with webhooks, native create/update and a lost creation response.
- `special-workflow-reviewed-so.test.js`: generated complete tuple changes,
  preserved sales prices and pallets, hybrid rejection, downstream PO preflight
  and pending-native-creation blocking before SO writes.
- `special-workflow-native-po.test.js`: native line references, vendor/source/
  yard/marker validation, existing-PO updates, no standalone fallback, ignored
  responses, duplicate/partial mappings, post-write corruption and facade wiring.
- `special-workflow-native-service.test.js`: native recovery both before and
  after durable submission, with no new creation or submission rearm.
- Existing `special-workflow-review.test.js` now expects SO=PO=20 instead of
  preserving the prior 1200/20 mismatch, following the user's explicit change.
  It observed RED on the old behavior before implementation.

RED was observed for the original description/revision/finalization bug, all
initial native adapter behaviors, native service recovery, quantity/UOM review,
downstream PO preflight and pending creation. The first coverage pass exposed
missing lost-response/service and unrelated-line corruption scenarios; those
were added and exercised rather than excluding the code. The original lint
configuration omitted Node's `AbortSignal`; a scoped config supplies that real
Node global. No assertions were relaxed to obtain a pass.

Deployment uses `server/tools/special-workflow-link-deploy.py` (`prepare`,
`apply`, `verify`) and only seven explicitly hashed files. Its initial gate
refused the older image expectation because an intervening Direct Ship release
was active. Every affected live source still exactly matched the captured
baseline, so the release was rebased on image
`sha256:1e77818e8f912c6802e4548641943867e3e6c20f1b9051a6c82dfc5b3f763baf`.
The unrelated release, environment, commands, mounts and dependencies are
preserved. The intervening container replacement removed the temporary
pre-recovery app snapshot; the recovery receipt and durable case events remain,
and the full before-snapshot for the rejected native-link attempt is retained.
Release receipts are under `server/test-artifacts/special-workflow-link-release-20260926/`.

Final release: `mbbs-operator-app:special-so-po-link-20260926`, image
`sha256:4a3e462575db1de0b9bd4a11163212cfcc9ed7b427371514a7c4cea5f1af4fac`.
Both app and webhook worker run the verified hashes; configuration, database
and Ollama containers are unchanged. Local and public `/health` returned 200,
and the served SCM review script matches the deployed file byte-for-byte.
The reproducible read-only checks are `tools/special-workflow-link-live.mjs`
and `tools/special-workflow-link-health.mjs`, run with Node from `/app` in the
production app container. Final `live-readback.json` confirms one existing
PO marker, matching reviewed values, no native retrofit for existing POB03934,
and SPREQ-000006's unchanged fingerprint.
