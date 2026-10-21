# Current sales order lines before Item Fulfillment

Tier 3: inventory posting and cross-yard isolation. Spec approval: not obtained
(autonomous run); the user authorized the general fix and existing deployment work.

## Acceptance criteria

1. SOA10159: canonical line 1 in yard 1 has 7 PC remaining; line 2 in yard 28
   was fulfilled by IF157622 and has zero remaining. Posting sends line 1,
   quantity 7, PCS 7, PLT/LYR/SEC zero, and omits line 2. No order IDs or yard
   IDs are hardcoded in the implementation.
2. Any order: omit only unselected source lines which are absent, closed, or
   have zero remaining. Keep every open unselected line explicitly false,
   including other yards, repeated item IDs, and kit parents. Current source
   coverage must include all visible REST source lines, not only inventory.
3. Preserve selected quantity, location, custom pack fields, external ID, and
   wrapper metadata exactly. Never clamp an operator quantity to a cached or
   freshly read total; the existing SQFT tolerance rule remains unchanged.
4. A selected missing, closed, completed, remapped, or moved line cannot be
   silently omitted. Invalid, duplicate, or unavailable current source evidence
   stops before the transform. Read failures are classified as not attempted.
5. Current evidence is fetched immediately before a new SO IF transform, once
   per attempt. Kit and Dispatch validation stays in force. Transfer orders and
   receipts keep their existing paths. Location parts validate their own
   selected subset and can omit a part already completed in NetSuite.
6. The durable logical payload and its hash are immutable. External-ID recovery
   happens before a new transform, so an existing verified IF never creates a
   duplicate even when the selected source line is now completed.
7. A real isolated database lifecycle posts and verifies the selected line,
   finalizes its local load once, preserves the other yard's draft, and leaves
   no local load on rejection or an unreadable source.

## Failure model and checks

- Static sublist operation on a completed line: recorded fixture and native
  network boundary rejecting that operation, randomized line availability.
- Omitted open false row accidentally fulfilled: opposite-bound properties
  assert every open unselected row remains false; kit-parent reader contract.
- Lost or altered selected quantity/packs: exact comparisons and properties.
- Source change/ambiguous identity: adversarial input and no-POST assertions.
- Duplicate fulfillment after a timeout: durable recovery and repeated worker
  execution with no additional transform.
- Foreign-yard draft loss: real repository and finalizer integration assertions.
- Race after the read: NetSuite remains final authority; rejection never
  finalizes locally. This fix does not bypass or retry a rejected mutation.

## Setup and verification plan

Use existing Node tests, fast-check, PostgreSQL, c8, TypeScript, ESLint, and the
repository's bounded isolated Compose runner. No dependencies, migrations, git
commits, or production data edits. Capture current live source and private
rollback configuration before implementation; overlay only this task's source
delta onto that image. Add focused unit/integration tests, executable baseline,
properties, mutation checks, diff coverage, release checks, and evidence under
the existing test/tools/artifact directories. Teardown is registered by the
standard runner before test databases start; remove all disposable resources.

Observe a behavior failure on the existing adapter before implementing. Run
the full affected posting/yard suite, shuffled order, baseline-relative types
and lint, changed-line coverage, independently exercised properties, and at
least five plausible mutation faults. Validate the actual order read-only;
deployment must preserve app configuration and other production containers.
No live test fulfillment is authorized by the verification plan.

## Clarification after the first broader run

The old direct SO HTTP test required only transform + IF read, with no source
read at all. That contract cannot detect fulfillment in NetSuite while local
progress is stale. The authorized general fix replaces that assumption with
one fresh source validation followed by exactly one create and one verify.
Keep the existing mutation-count assertions; update the network fixture to
return source evidence and assert each new read explicitly. No extra mutation
or generic 400 retry is allowed.

An open fulfillable line added since the app loaded must also be deselected.
Append a false row for each current open fulfillable source line absent from
the saved payload. Omit current nonfulfillable rows. This prevents the native
transform's defaults from fulfilling an operator-unselected new line.
