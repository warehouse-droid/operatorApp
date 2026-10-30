# Initial travel must not freeze future stops

Spec approval: not obtained (autonomous run). The user reported today's Dao
Load 2 incorrectly protecting stop 6 despite no pickup or delivery having
started. The read-only investigation found one active initial travel job to
UNILOCK Ayr, with no physical activity in that load.

Scope: Tier 3 checks for the browser's execution guard. Change only the browser
guard and its asset version in production. Keep server validation, recorded
jobs, plan contents, assignments, and execution history unchanged. No new
dependencies, package changes, git commits, schema changes, or external writes.
Use the existing disposable bounded test runner and remove its containers,
networks, volumes, generated runtime sources, logs, and coverage after each run.

Acceptance criteria:

1. An active initial-travel job with the standard seven-part encoded job ID,
   matching load, an empty leg key, and a destination matching the first pickup
   protects that pickup and earlier stops, while permitting reorder of later
   unstarted stops. Reproduce Dao's six-stop route and travel metadata without
   customer details or credentials.
2. Keep the destination pickup in its current position. Moving later work
   before it remains blocked. Repeated visits to its yard do not extend this
   initial-travel boundary to the later visit.
3. A started/completed physical pickup or delivery still protects the prefix
   through its recorded position. Other loads' activity and completed/pending
   travel do not create a boundary.
4. Existing explicit destination stop IDs and legacy IDs ending in a stop ID
   retain their existing behavior. Their evidence takes priority over initial
   travel recovery. Both camelCase and snake_case records remain supported.
5. Missing/malformed job IDs, a nonempty inter-stop leg key, a mismatched load,
   a changed destination, and no matching pickup retain the conservative whole
   load boundary. URI punctuation and Unicode in load IDs and yards work
   without decoding malformed input or throwing.
6. The guard is pure: it does not modify route or activity records. Existing
   server executed-prefix policy continues to allow a legal suffix reorder and
   to reject edits to recorded physical work.
7. Publish an app-only image overlay over the captured live image with exactly
   two public files changed, a rollback image, preserved runtime configuration
   and dependencies, successful health, and verified served asset hashes.

Failure model and evidence layers:

- Overbroad protection: incident regression and generated suffix permutations.
- Lost execution protection: physical-prefix, destination-prefix, ambiguous
  travel, and wrong-load tests; manual mutation of each guard condition.
- Wrong travel parsing: encoded punctuation/Unicode properties, malformed IDs,
  inter-stop identifiers, and explicit-target precedence tests.
- UI/server disagreement: actual browser functions plus real server policy
  evaluated on the same routing fixture; existing related regression suites.
- Unrelated deployment changes: two-file overlay, captured baseline hashes,
  stale-image guard, config comparison, health and served-file verification.
- Test artifacts affecting the live host: retention wrapper, registered Compose
  teardown, bounded mbbs-tests.slice containers, docker ps and docker ps -a.

Validation uses the existing Node test runner, fast-check, TypeScript, ESLint,
and c8. Persist a single gauntlet entry point, report baseline failures and zero
new failures, changed-guard coverage, mutation results, and explicit limitations.
