# SN1400333 receiving correction (Tier 3)

Spec approval: not obtained (autonomous run under the user's requested receiving
correction). This is the reviewable specification, with lower confidence than
an independently approved specification.

## Observed failure

The failed 2026-09-15 22:17:09 UTC command already targets POB03658 / 936958.
Its 39-line IR payload omits memo and includes fully received lines 9, 16, 20,
29 and 37 as itemReceive:false. Selected lines are 15:1305.6, 18:629.46,
23:930 and 38:32. A read-only external-ID lookup found no created receipt.
Completed-line inclusion is the likely 400 cause; no live transform will be
submitted just to prove it.

## Executable acceptance criteria

1. A split PO SN1400333 / -74756816273767 resolves through its active database
   ledger to PO POB03658 / 936958, and the adapter receives positive ID 936958,
   memo exactly SN1400333, and the selected source lines and quantities above.
   The reference comes from the stored receiving order, not the client or PO memo.
2. IR payloads omit source lines whose authoritative remaining quantity is zero.
   All other open source lines remain explicitly deselected unless selected;
   nonsequential REST line 63 is retained with its original identity.
3. A selected completed line remains in reconciliation evidence with zero posted
   quantity. An entirely completed selection creates no transform. A partial line
   posts at most its remaining quantity. Unknown remaining quantities retain the
   existing behavior. SO/TO fulfillment payload behavior stays unchanged.
4. Memo is part of the immutable payload and input hash. Identical receipt memo
   references may aggregate; conflicting references for one parent fail before
   posting, so later SCM allocation cannot confuse multiple shipment numbers.
   Blank/absent memo is omitted; fulfillment does not acquire a receipt memo.
5. Generated selections and remaining quantities verify both inclusion and
   exclusion, exact quantities and source identities, across PO/TO IR and SO/TO
   IF. Existing identity, quantity, yard, adapter recovery and command tests stay.

## Failure model

- Wrong parent/line/quantity: real resolver + domain + adapter contract execution,
  live read-only comparison, deterministic properties and deliberate mutants.
- Accidental receipt of other open lines: exact full payload assertions and
  two-sided properties; retain explicit itemReceive:false for unselected lines.
- Duplicate receipt or false local reconciliation: existing idempotency/recovery
  suite plus completed/partially completed selection tests. No retry of the failed
  live command or alteration of stored failed-command evidence is authorized here.
- Lost/ambiguous shipment attribution: stored-reference test, memo hash and
  conflicting-reference tests.
- Concurrent external PO changes/closed lines/NetSuite customization: remaining
  limitation; a read is not an atomic transform preview. No guarantee of live
  NetSuite acceptance from a mocked transport.

## Setup and scope

Use existing Node 20, PostgreSQL, fast-check, c8, ESLint and TypeScript in the
installed test Docker image. Add tests/spec/evidence and reproducible tools under
test/ and tools/. Reports go in test-artifacts/sn1400333-receiving. No dependency,
schema, public endpoint, UI, commit or deployment changes. Preserve preexisting
working-tree edits; capture pre-change sources and full-suite/static baselines.
Use disposable isolated databases and source copies for mutations. Production
access is read-only. Runtime edits are limited to posting-target memo propagation
and posting-domain payload construction.

## Verification additions

The property generator explicitly weights zero remaining quantity, so completed
lines appear frequently in mixed receipts. A missing/blank stored receiving
reference must omit memo, never substitute the vendor's existing PO memo.
These strengthen scenarios 2, 4 and 5 without changing their expected behavior.

## User clarification: completed lines are outside the split

The user correctly notes that parent REST lines 9, 16, 20, 29 and 37 do not
belong to SN1400333. A fresh active-ledger read confirms its only parent REST
lines are 15, 18, 23 and 38. The other 35 parent lines were introduced by the
posting draft's explicit-deselection list. This clarifies the observed request;
it does not establish the exact NetSuite rejection cause or change the four
selected lines in the acceptance criteria. No further runtime change follows
from this clarification alone.

## Authorized deployment

The user explicitly requested deployment. Release the two tested runtime files
on top of the currently running image, preserving all other image contents,
environment settings, mounts, ports, and service commands. Retain the prior image
and Compose configuration for rollback. Validate the candidate's exact file
differences and run the receipt/posting unit contracts using its actual sources.
Recreate only app and webhook-worker, then check health, image/source hashes,
worker startup, public availability, and unchanged database/Ollama containers.
Rollback the app and worker if the deployment verification fails. Deployment
does not authorize submitting/retrying a NetSuite receipt or modifying the failed
command. The existing passing implementation evidence remains valid when source
hashes match; no application implementation changes are part of deployment.
