# Closed Custom Discount% verification evidence

Spec approval: not obtained (autonomous run). Continuation of Special request progress/SO-only closure, Tier 3.

Live SuiteQL evidence after the REST close showed SOB121381 `Sales Order : Closed`, material 2055 and PALLET 1784 closed, discount item 10716 with line_closed=F, and zero executed/billed quantities on every line. The previous fixture assumed that discount flags always close with material. This difference caused final verification to stop while retaining the local journal in attention.

The correction exempts only item 10716 from the physical-line closed flag. The order must still be Closed/Cancelled, every material/PALLET line must be closed, all execution/billing must be zero, and complete identities and saved financial fingerprints must match. It never writes a discount closed flag.

Two new tests reproduced the failure before the one-line fix. The property varies discount/material/PALLET identities, Closed/Pending Fulfillment status and execution/billing quantities. The saved-plan lost-response test verifies that the SO closes once and recovery only reads it. Existing adversarial identity, open workflow lock, changed fingerprint and partial pair tests remain passing.

Reproduce: `python3 server/tools/special-closed-discount-check.py`. Final results: **69/69** related tests passed, reversed file order passed, changed lines **1/1**, changed branches **4/4**, and **3/3** mutants killed by property tests. Types, syntax, lint and scoped secret scan passed. UI files are unchanged from the prior verified release; no redundant browser run was needed for this backend-only correction. No dependencies or schema changes; dependency audit inapplicable.

Source hash `3b3bc7108ff3917dbbd482cd7d529b38395fe30fa41b2839d3a0420f67a74ef2`. Tool versions `{"node": "v20.20.2", "typescript": "7.0.2", "eslint": "10.8.0", "c8": "12.0.0", "fast-check": "4.9.0", "playwright": "1.62.1"}`. Logs, source manifest, baseline, diff and coverage: `server/test-artifacts/special-closed-discount/`.

Deployed only the adapter delta over the verified UI/SO-only release: image `sha256:105450a19f63eb8f9749440a3d1f1fdedb540307a80430135bbc58618c423c22`. Configuration and dependencies were preserved. The immutable recovery checkpoint survived container replacement with SHA-256 `863f75ec6c5074497f74bd744316383d0cde23fca3f6ff449d4103ac0bae12a7`. The finalization mode rejects every NetSuite write and resumes only the recorded case-64 closure journal after verifying its unchanged plan and requester's yard scope. Protected-request hashes cover SPREQ-000006 and SPREQ-000007.

The first recovery guard stopped before any order write because an optional undefined discount unit field was omitted in serialized JSON. Comparing the same serialized representation corrected that check. The next REST close succeeded remotely and revealed the discount-flag mismatch described above. No test assertion was weakened; the new behavior is explicitly scoped in the accompanying spec.

Final live result: SOB121381 verified **Closed in NetSuite**; its local SO is Closed, SPREQ-000009 is cancelled with closeStatus=closed and an approved closure journal. Finalization performed **zero further NetSuite writes**. SPREQ-000006 and SPREQ-000007 match their pre-recovery business hashes. Result and recovery script hashes are recorded in `server/test-artifacts/special-operation-progress/recovery-result.json` and `recovery-source-manifest.json`.
