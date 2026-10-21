# NetSuite attention queue repair — 2026-10-03

The deployed repair prevents preparation states from becoming false NetSuite errors, preserves recovery without duplicate posting, handles explicitly registered first splits, excludes authoritative billing-only rows from future SO fulfillment payloads, and distinguishes missing load evidence from failures in Admin.

User authorization: resolve the queues and verify existing IF/IR before retry. Spec approval was not obtained during this autonomous run; the executable criteria and later discoveries are in [SPEC.md](SPEC.md). No NetSuite transaction was created by this maintenance reconciliation.

## Production result

Final independent readback at **2026-10-03 22:44:28 UTC**:

- Native NetSuite verification attention: **0**.
- Delivery SO queue: **18 waiting for recorded Operator/direct-source load evidence**, **1 attention**.
- **44 entries resolved**: 18 existing attempts completed against verified IFs, 24 externally fulfilled orders reconciled, and 2 service-only orders skipped because no item fulfillment was required.
- Main snapshot contained 62 entries. SOA09706 arrived before deployment, after the snapshot; its absent IF/IR and missing Operator evidence were separately verified, then restored to waiting.
- **SOA08709** remains blocked by NetSuite's user-defined workflow. Existing IF154003 was verified. Remaining 10 PC on physical line 12 has Operator load 1170 and matching Driver completion, but NetSuite rejects exact source verification with `USER_ERROR`. The read-only remainder rehearsal stopped before posting; the verified blocker is recorded in Admin.
- **TOB01189**: locally Loaded; **IF156491 (1037916)** verified against source 1036611, physical lines 2/5/8 and quantities 5/1/4. Cached header now matches NetSuite **Pending Receipt**. No linked IR exists. No receiving event was invented.
- Audits: 55 SO reconciliation events, 1 workflow-block event, 7 native reconciliation events, and an explicit TO cache reconciliation audit. Original posting intent and immutable snapshots were preserved. Proven legacy base-unit quantities were corrected through separately audited source/UOM comparisons; TO display quantities were unchanged.

The two local repair stages both passed full rollback rehearsals before application. Existing IF records and authoritative source quantities were fetched again immediately before application. Reconciliation tools import no NetSuite transform/posting adapters. All maintenance mutations use guarded database transactions and leave immutable physical evidence intact.

## Deployment

App image: `mbbs-operator-app:netsuite-attention-20261003-v1`.

Image ID: `sha256:137de6b4c7bd2338db29b150e81d4b7b391e2cd512d2352f98febe4652d23f77`.

Six reviewed files were overlaid on the newer concurrent release `sha256:63c82749646b160c605a97da3d4d16dbe6f12b2475a2e3d8c3dec4e31ce10192`. The affected baseline files were confirmed identical before overlay. Running configuration, credentials, ports, volumes, dependencies and the unrelated webhook worker were preserved. All six running file hashes match the reviewed manifest; the health endpoint reports healthy. No schema migration or dependency change was needed.

Rollback is retained as `mbbs-operator-app:netsuite-attention-base-63c82749646b` and the private compose rollback override. The deploy tool guards runtime identity and reviewed source hashes. Production configuration snapshots and detailed record evidence remain in the mode-700 private investigation directory; they are not copied into this report.

## Executable evidence

Artifacts: [test-artifacts/netsuite-attention-20261003](../../test-artifacts/netsuite-attention-20261003/).

- **230/230 focused tests passed**, repeated in a different file order: **230/230**. Includes durable recovery, multipart P3/P4/P7/P10, source drift, exact line/item/quantity identity, first-split quantities, Operator/Driver evidence, and waiting-state polling.
- **5/5 browser checks passed**; screenshot and browser result retained.
- **6/6 deliberate mutants killed**, all also killed by the property suite alone: waiting work posts, ordinary recovery posts, billing exclusion inversion, split uses parent quantity, split ignores item identity, and wrong UOM factor.
- **95/95 changed instrumented backend lines covered**. This is changed-line coverage, not full-module coverage; new helpers and the reviewed existing-record proof helper have 100% line coverage. Branch coverage across the instrumented modules is 68.88%, including large unchanged modules.
- Scoped lint and final changed-diff secret scan passed. Type checking still reports **274 pre-existing diagnostics**, with **0 new diagnostic signatures** compared with the captured baseline.
- The broad MBT run executed **833 files**, reporting **81 failed files**. One task regression in multipart recovery was fixed and all 12 tests in that file passed in the final focused run. Two other new failures relative to the earlier baseline were reproduced with this task's production changes removed: the existing special-stock UI regex and an integration test requiring a different DB hostname. The other failures overlap the earlier failing baseline. The broad suite remains non-green; it was not repeated after the final multipart/historical guard refinements because all affected suites were rechecked.
- Earlier red logs demonstrate the preparation-state, unsupported-yard reason, recovery, polling, source exclusion, registered first-split and historical-resolution regressions before their fixes. No production data was used as a mutable test fixture.

Reproduction commands (Docker access required; checks use the existing isolated test runner and disposable databases):

```sh
python3 tools/netsuite-attention-20261003/gauntlet.py focused
python3 tools/netsuite-attention-20261003/gauntlet.py static
python3 tools/netsuite-attention-20261003/gauntlet.py mutation
python3 tools/netsuite-attention-20261003/baseline-repro.py
python3 tools/netsuite-attention-20261003/evidence-summary.py
python3 tools/netsuite-attention-20261003/read-live.py verify-final.mjs verification-final.json
```

Repair scripts deliberately assert the reviewed pre-repair versions and should not be rerun after application. A new repair requires fresh evidence and a new review. `remaining-if.mjs` has not been applied; the NetSuite workflow lock must be resolved and all source/evidence checks repeated before any SOA08709 posting.

## Review boundaries

No verifier tolerance was loosened. Special historical recoveries require exact authoritative source identity, quantities, units, locations and independent evidence for extra non-stock rows. Recovery of an ordinary uncertain result cannot create an IF. The established per-location adapter can resume an unattempted or definitively rejected part, while uncertain or completed parts remain protected. Explicit audited historical resolution matches the existing claim boundary; automatic historical posting stays disabled.

Waiting orders were not marked fulfilled or physically loaded. Once sufficient immutable evidence exists, they return through the normal gated worker. SOA09620 already has IF156324; only 10.46 SQFT remains and must not be posted without its missing Operator evidence. Registered first splits retain bounded split quantities instead of the full parent quantities.
