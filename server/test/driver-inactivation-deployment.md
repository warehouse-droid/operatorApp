# Driver inactivation deployment — 2026-10-29

User authorization: “deploy”. The app switched successfully at **15:51:18 UTC**.
Final verification at **15:52:01 UTC** found it healthy with zero restarts.

Release: `mbbs-operator-app:driver-inactivation-20261029`

```text
sha256:b43ec16d085070e5e2e66d1007f816af9cf0de41a5095c211f7311141df1e4b5
```

The release applies only the eight driver-inactivation runtime files over the
captured live image. Other live source, configuration, database, webhook worker
and Ollama were preserved. No schema migration or production test data was used.

- **40/40 tests passed across 9 files** against the exact release candidate:
  deactivation, access revocation, planning, reassignment, BIN confirmation and
  execution, offline BIN work, fleet endpoints and historical-assistance races.
- The built image's **1,604 runtime files** matched the validated candidate;
  the server import check passed in a bounded networkless disposable container.
- Cutover checked for active posting/completion operations before recreating
  only the app service. Rollback was prepared but not needed.
- Local and public `https://test.mbbsoperation.com` health requests returned
  **200**, the served setup asset matched its release hash, and anonymous
  management/driver requests returned **401**. All live runtime hashes matched.
- Final `docker ps` and `docker ps -a` contained only the four production
  containers. Test containers, database storage, networks, artifact directories,
  logs and temporary build context were removed.

Release operations are reproducible through
`server/tools/driver-inactivation-release.py` with the sequential commands
`prepare`, `validate`, `build`, `image-check`, `apply`, and `verify`.
Validation and image checks use the repository's disposable lifecycle runner
and bounded test containers. The initial image build was corrected to use a
verified local rollback tag rather than a bare image ID in `FROM`; production
remained unchanged until validation and image checks passed.

Operational records and rollback metadata are retained in
`server/deployments/driver-inactivation-20261029` under the repository's
deployment retention policy. Rollback image:
`mbbs-operator-app:driver-inactivation-rollback-20261029`, corresponding to
`sha256:44a4c777e5dd44fb1f5251257708c285094789fdd8179d96094ed5648dd86a98`.

The broader implementation verification and unchanged baseline failures are
recorded in [driver-inactivation-evidence.md](driver-inactivation-evidence.md).
