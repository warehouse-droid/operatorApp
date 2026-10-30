# Admin IR/IF routing gate — 2026-10-21

Deployed the six-file overlay recorded in
`deployments/ifir-admin-gate-20261021/manifest.json`, preserving unrelated live
changes. Image: `sha256:fc2d82d1c7f00a23379efb8695328e69cba70ee741dc5d5069ed64b633be8f00`.
All 1,431 runtime file hashes and unchanged production dependencies/configuration
were verified. Rollback image and operational audit are retained.

**Current setting: OFF at the user's subsequent request.**
`artifacts/ifir-admin-gate-20261021/user-disabled.json` records revision 3,
configured/effective false, and a live native-routing check making zero NetSuite
requests. Deployment verification now reads the current choice without changing
it. The original native posting path remains available; the database toggle
does not close existing yard posting permissions.

Spec: `test/ifir-admin-gate.spec.md`. Spec approval was not obtained (autonomous
run). No new dependencies or commits. Failure model covers misleading UI state,
stale cached choice, deployment-boundary bypass, migration replay, and duplicate
post after uncertain responses.

Reproduce on the recorded candidate with:

```sh
IFIR_ADMIN_GATE_RUNTIME_ROOT="$PWD/server/deployments/ifir-admin-gate-20261021/candidate" \
IFIR_ADMIN_GATE_SOURCE_ROOT="$PWD/server/deployments/ifir-admin-gate-20261021/candidate/src" \
IFIR_ADMIN_GATE_BASELINE_ROOT="$PWD/server/deployments/ifir-admin-gate-20261021/before" \
bash server/tools/ifir-admin-gate-checks.sh
```

- Initial four contracts failed before implementation. An additional UI test
  caught Dispatch-specific readiness blocking the switch; corrected and passed.
- Final relevant regression/API/database suite: **311 tests, 310 passed**.
  One pre-existing failure also occurs in the baseline:
  `property: a real unapproved PO remains Confirmed until approval, except terminal stages`.
  No new failures. Reversed unit order: 302 tests, 301 passed, same baseline failure.
- HTTP tests cover authorization, audited on/off, revision conflicts,
  idempotent replay, and repeated migration preserving the choice. An exhaustive
  property covers deployment enablement, direct access, URL, and database state.
- Type diagnostics: 7,594 baseline/current, no new issues. Lint: 145
  baseline/current, no new issues. Syntax and secret checks passed.
- Changed executable lines: **38/38 covered**. Manual mutants: **4/4 killed**.
  Property-only tests kill the three policy-boundary mutants; the async-setting
  mutant is killed by sequential-post/error tests, not by the policy property.
- Node v20.20.2; TypeScript 7.0.2; ESLint 10.8.0; c8 12.0.0.

Tests used bounded isolated Compose services in `mbbs-tests.slice` without
production credentials or volumes. Containers/network were removed. Artifact
ownership initially prevented the host coverage-report update and artifact
cleanup; retained evidence was checked, ownership repaired, and the disposable
directory removed. The harness now repairs only its own artifact ownership before
cleanup. Both Docker container listings showed only the four production services;
the app remained healthy. Production posting was not used for these checks.

Unrelated application/browser suites and dependency audits were not rerun; the
generic Admin renderer is unchanged and the dependency set did not change.
