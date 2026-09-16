# Grouped CO correction — 15 September 2026

## Applied result

**12 additional grouped COs were corrected live at 17:01:52 UTC.**
All 15 reviewed grouped COs now return Operator `loaded` / `Loaded` and are absent
from the active Operator feed; three were already Loaded. Live verification
completed at **17:02:13 UTC**, with zero remaining changes.

| Reported CO | Why the first cleanup missed it | Current source evidence | Result |
| --- | --- | --- | --- |
| CO-GOA-5381-5391 | Its legacy source-group definition is retired | SOA05381: F / Pending Billing; SOA05391: G / Billed, verified directly in NetSuite | Loaded; absent from active feed |
| CO-GOB-119005-119006 | Its group is in the global registry, absent from the legacy table | SOB119005 and SOB119006 have completed Driver deliveries | Loaded; absent from active feed |

The first cleanup was too restrictive about historical group definitions. Each CO
already records its source-group identity and member IDs. The corrected maintenance
resolver verifies every recorded member against current completion evidence and
does not rely on obsolete snapshot statuses or infer membership from a group name.
Optional child cards, when present, must agree with the recorded member IDs and
SO type. Missing member proof, duplicate/conflicting identities, incomplete members,
the 13 review SOs, and active Operator work remain excluded.

The correction updates only CO status and its load-evidence metadata. Stored cargo
and receiving quantities, source SOs, Driver records/photos, plans and source-group
lifecycle remain unchanged. The existing deployed Operator Loaded projection
handles the corrected records; no additional app deployment was needed.

## Evidence

- Initial behavioral tests: **4 failed**, reproducing both omissions, identity
  conflicts and the property counterexample before the resolver correction.
- Final relevant regression suite: **25 passed, 0 failed, 0 skipped**.
- Five plausible faults were rejected by both the full new test file and its
  independent property test: **5/5 suite kills and 5/5 property kills**.
- Targeted static lint passed after simplifying the membership validator.
- The isolated rehearsal imported the exact 12 CO before-images and **65 stored
  cargo lines**, with the **24 corresponding SO sources**. It verified transaction
  rollback, application, exact after-images, unchanged source/Driver/cargo state,
  Loaded detail responses, active-feed removal and an idempotent repeat.
- The isolated registry fixtures preserve captured membership and lifecycle; their
  required historical plan pointers are test scaffolding. Driver completion
  witnesses are test-only records. No simulated operational actions ran live.
- Live application revalidated the exact manifest under the existing Fleet and
  Operator locks. The transaction checked the complete captured SO state and all
  CO lines before committing.
- Independent read-only verification checked all 15 reviewed CO detail responses,
  active-feed removal, exact stored cargo, and unchanged review SO headers.

The runtime application source did not change in this follow-up. The relevant
25-test suite was rerun; the previously recorded full application/Dispatch suites
were not rerun for this maintenance-only correction.

## Corrected references

- CO-GOA-4505-4506
- CO-GOA-4578-4583
- CO-GOA-4696-4705
- CO-GOA-4948-4950
- CO-GOA-4915-4916
- CO-GOM-4932-4934
- CO-GOA-5381-5391
- CO-GOA-5621-5622
- CO-GOA-5691-5760
- CO-GOA-6022-6023
- CO-GOB-116389-116391
- CO-GOB-119005-119006

## Audit artifacts

Artifact directory: `server/test-artifacts/so-delivery-cleanup-grouped-co-20260915/`

Retained files include `co-before.json`, `co-manifest.json`, `co-after.json`,
`co-apply-result.json`, `live-verification.json`, `red.log`, `focused.log`,
`mutations/results.json`, `lint.log`, and `rehearsal.json`.

Applied manifest SHA-256:
`562bfd421d2fd65c38a09402a7735850b46cf28934de8e350f879bd2b3e95650`.

[Original cleanup report](so-delivery-cleanup-apply-evidence.md)
