# Initial travel planning guard — evidence

The fix is deployed as `mbbs-operator-app:dispatch-start-travel-20261022`.
At 2026-10-22 18:20:58 UTC the application was healthy, both served dispatch
files matched the tested hashes, runtime configuration was preserved, and the
database, webhook worker, and Ollama containers were unchanged. No dispatch plan
or driver job was rewritten. The initial pickup remains protected while later
unstarted stops can move.

The user explicitly approved deployment with “Deploy the fix” after automatic
approval review initially rejected the production mutation. Spec approval was
not obtained: the coding run was autonomous. Deployment approval is a separate
authorization and does not imply independent review of the specification.

Reproduce the complete bounded validation from the repository root:

```sh
python3 server/tools/dispatch-start-travel-run.py
```

The entry point uses `docker/run-isolated-tests.sh`, its unique artifact
directory, registered teardown, and `mbbs-tests.slice` budgets. Logs, coverage,
mutants, generated type-check sources, containers, disposable databases, and
networks are removed. Only concise source evidence and deployment audit/rollback
records are retained.

Final fresh run: 2026-10-22 18:19:25 UTC. Machine-readable results, source hashes,
tool versions, and the enforced shuffled file order are in
`dispatch-start-travel-20261022-evidence.json`.

| Constraint | Final evidence |
| --- | --- |
| Incident and guard scenarios | 14/14 tests passed in `../frontend/dispatch-start-travel-boundary.test.js` (repository path: `test/dispatch/frontend/dispatch-start-travel-boundary.test.js`). |
| Related regression suite | 96 tests in 12 files: 94 passed, two baseline failures, zero new failures. |
| Suite health | Same counts and failures with the 12 files run individually in a deterministic shuffled order. Node sorts multiple file arguments, so separate processes enforce the intended ordering. |
| Encoded identifiers and arbitrary suffix ordering | Two fast-check properties, 100 cases each, fixed seeds 20261022 and 3667164. |
| Changed guard coverage | 44/44 statements covered across the two actual extracted production functions, `driverActivityDetails` and `dispatchEditableRouteBoundary`. This is not whole-file coverage. |
| Mutation | 6/6 deliberate faults rejected: blanket lock, unlocked destination, wrong load, nonempty inter-stop leg, wrong yard, and ignored physical activity. |
| Property-only mutation | 5/6 rejected. The physical-activity mutant is rejected by the named scenario tests; the suffix and encoding properties alone do not establish physical-evidence protection. |
| Syntax | `node --check public/dispatch.js` passed. |
| Lint | Scoped extracted guard lint passed with zero errors/warnings using ESLint 10.8.0. |
| Types | Extracted routing fields passed TypeScript 7.0.2; existing legacy union/JSON boundaries retain `any`. |
| Production execution | App-only deployment, healthy `/health`, and both public asset hashes verified. No live route mutation was used as a test. |
| Dependencies and capabilities | No dependency or lockfile changes. Reviewed the two-file release patch: no secrets or new network/filesystem/environment capabilities in the application guard. |
| Host cleanup | The disposable runner and deployment verification checked both running and stopped container lists; only the four production containers remained. |

The RED run used the same 12-file scope before changing implementation: 96 tests,
86 passed, 10 failed. Eight failures reproduced the incident/associated guard
behavior, and two were already present:

- `RP-08 sequence, timing, capacity, labels, and tooltips use visit-scoped orders`:
  an existing frontend test expects an obsolete September CSS asset version.
- `RP-05 active travel protects its destination while allowing work after it`:
  an existing server-policy expectation differs from the current executed-prefix
  policy. The server implementation and test assertions were left unchanged.

An intermediate validation failed because the temporary TypeScript verification
fixture omitted legacy parameter/record-field declarations. Those declarations
were corrected and the complete final gauntlet reran successfully. No behavior
assertions were weakened. Node v20.20.2, fast-check 4.9.0, and c8 12.0.0 were used.

Acceptance mapping to the append-only specification:

1. Dao's initial travel and legal suffix move: incident scenario plus both
   properties and the real server-policy scenario.
2. Destination and repeated yard: destination-position and repeated-yard cases;
   the unlock-destination mutant is rejected.
3. Physical activity and inactive/other-load travel: physical-prefix and
   inactive/unrelated travel scenarios; ignored-physical mutant rejected.
4. Existing formats/precedence: explicit stop ID, legacy suffix, JSON details,
   and camelCase scenarios plus the existing repeat-pickup suites.
5. Ambiguity and encoding: invalid identifiers, absent pickup, URI/Unicode
   properties, and wrong-load/inter-stop/wrong-yard mutations.
6. Purity and server guard preservation: immutability and real server-policy
   scenarios plus related executed-work suites.
7. Narrow release: `deployments/dispatch-start-travel-20261022/release.patch`,
   `manifest.json`, `config-check.json`, `deployed.json`, and `containers.json`.

Full application and browser layout suites were omitted because this change
only modifies an existing pure planning guard and asset version. The browser
functions execute directly in a VM; a live drag/save was not performed. Automatic
rollback was not triggered; the prior image is retained as
`mbbs-operator-app:dispatch-start-travel-20261022-rollback`.
