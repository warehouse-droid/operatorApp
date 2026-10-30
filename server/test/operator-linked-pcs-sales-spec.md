Operator linked PCS validation — 2026-10-26

User acceptance rule: convert linked PCS to the line's sales UOM before checking
the Dispatch target. SOA10762 has 8 EACH of PALLET, one linked PCS/EACH, and seven
EACH of yard work. Its zero PCS annotation is not a zero sales target.

Tier 3 verification is scoped to this fulfillment quantity guard. Spec approval:
not obtained (autonomous run); the user explicitly authorized the fix and supplied
the conversion rule. Existing Node, fast-check, PostgreSQL, ESLint, TypeScript
and c8 tools will be used. No dependency, schema, production-data, gate or git
commit changes are planned. Add focused tests, reproducible checks and release
audit records, then deploy one module over the current live image with rollback.

Acceptance scenarios:

1. Eight EACH with zero/missing PCS annotations and one linked PCS is allowed;
   seven sales units remain. EACH/EA/PC/PCS/PIECE/PIECES use a one-to-one fallback
   when an explicit PCS conversion is absent. Positive explicit conversions win.
2. Ten SQFT with 2.5 SQFT per PCS and two linked PCS leaves five SQFT; four linked
   PCS consumes the line. PCS annotations do not independently cap this quantity.
3. Convert PO and direct-to-customer TO PCS separately and combine their sales
   quantities. A stored sales quantity and its PCS representation count once.
   Preserve a larger stored sales total (it may include other package types);
   use converted PCS as the minimum sales quantity, including legacy zero totals.
4. Reject converted over-allocation in sales units, even if the stored linked
   sales value understates the PCS. Unknown conversions and physical-only legacy
   requirements retain their existing validation. Negative/non-finite inputs and
   conversion overflow fail closed. Cancelled links and yard replenishment do not
   reduce yard work. All source input objects remain unchanged.
5. A synthetic 3445 group with loaded material plus an 8-EACH PALLET line linked
   for one EACH is initially underpacked but unblocked. Operator can pack and
   load the remaining seven; source ordered quantities and links stay unchanged.
   A real 9-of-8 link still prevents packing without a partial write.
6. Standalone, group, batch and list projections agree. Existing linked quantity,
   packing, direct supply, CO and fulfillment suites retain their behavior.

Failure model and evidence: converted-unit mistakes, double counting, falsely
allowed excess and falsely blocked valid links are checked by unit/property tests
and targeted mutants; actual Operator packing/loading and atomic rejection are
checked in a disposable database. Source immutability and public result fields
have regression assertions. A pure calculation introduces no new concurrent
writes. Full-repository tests unrelated to this boundary and external NetSuite
posting are outside this fix; affected suites and exact live readback are required.
