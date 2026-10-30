# PO to TO handoff

User policy, 2026-10-22: quantities count as covered after **Order Request**.
PO proposals without that action cover zero; the remaining shortage goes to
the TO phase. This supersedes scenario 8's requested-proposal exclusion in
`smart-scm-phased-po-split-spec.md` for the phase handoff only.

Tier 3: purchasing and inventory recommendations. Spec approval: policy
confirmed in chat; detailed executable specification not separately approved
(autonomous run).

Setup: existing disposable Compose runner, Node tests, fast-check, c8, ESLint,
TypeScript; no new dependencies, migrations, commits, or production data edits.
Keep unrelated workspace changes. All test output uses the runner's unique
artifact directory and is removed, together with containers/networks/volumes.

Acceptance scenarios:

1. Need 8 PLT, unrequested PO 8: TO need remains 8.
2. Need 8 PLT, requested PO 3: TO need becomes 5. A fully requested 8
   leaves zero. Coverage is specific to SKU and physical receiving yard.
3. An unrequested priority replenishment or Stocking Purchase proposal does
   not reduce TO demand. Requested quantities use the same handoff rule as
   ordinary PO proposals, including split/grouped loads and earlier runs.
4. Real PO quantities remain represented by authoritative inventory/split
   overlays; their proposal quantities are never subtracted a second time.
   Blanket proposals keep their existing reservation/coverage treatment.
5. Cancelled, superseded, failed, and completed proposals, cancelled lines,
   missing request timestamps, non-POs, and nonpositive or invalid quantities
   cover zero. Staged vendor review covers confirmed quantities only.
6. Partial pending coverage is applied after existing Blanket coverage and
   cannot make required or residual quantities negative. Coverage never
   changes physical stock, policy floors, or the inventory position.
7. Repeated/concurrent phase approval produces one frozen set of proposals
   and coverage evidence. Failure rolls back phase and proposals together.
8. Existing integrated/phase-one planning, actual inbound/split calculations,
   manual TO controls, source-stock protection, and historical frozen plans
   remain unchanged. For the reported example, source stock 24 below ROP 35
   still supplies zero automatic pallets even when destination need is 8.
9. Phase review and TO calculation explain Order Request coverage and the
   remaining demand. Confirmation does not claim unrequested POs are inbound.

Failure model and detectors:

- Lost or duplicate demand: exact partial/full/zero database scenarios,
  conservation properties, and deliberate faulty-coverage mutations.
- Wrong yard or staged quantity: SKU/yard isolation and vendor-review tests.
- Double counting real POs or Blanket reservations: database regressions and
  independent inventory-position assertions.
- Races or partial writes: repeat/concurrent approval and rollback tests.
- Silent stock-floor relaxation: reported 24/35 example regression.
- Workflow/UI drift: execute phase panel/calculation rendering and existing
  phased-planning, purchase request, split-inbound, and manual TO suites.
- Tooling limits: report actual changed-line coverage, scoped types/lint,
  mutation results, source hashes, and any skipped layers in evidence.

Setup addendum: the first disposable build encountered an unreadable historical
test-artifact directory. Exclude generated `test-artifacts`, `artifacts`, and
deployment copies from Docker build context; retain their existing contents.

Baseline addendum: `src/smart-scm-blanket-ui-harness.js` fails on the original
HEAD/live HTML too, expecting the obsolete exclusions asset version
`20260801-po-only-pauses-v1`. Preserve the test and its visible failure; accept
only this exact baseline failure and require zero new failures. Do not change
the unrelated exclusions asset or weaken its assertion.
