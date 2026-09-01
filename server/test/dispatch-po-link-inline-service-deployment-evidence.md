# Production deployment evidence — inline PO-link service-fee checkbox

Date: 2026-09-01 UTC

## Scope

- The release overlays only `public/dispatch.js`, `public/dispatch.css`, and
  `public/dispatch.html` on the previously healthy production image.
- The live-to-workspace diff contained only the inline service-fee card UI,
  matching guards/state, styling, and browser cache-version bump.
- No server, worker, dependency, migration, schema, or production-data change
  was included. A database backup was therefore not required for this
  browser-asset-only release.

## Predeployment evidence

- Focused PO-link frontend packet: 8/8 passed.
- Exact changed JavaScript and tests: ESLint passed with zero warnings.
- The explicit MBBS-Special service-fee integration regression passed.
- The broader Link PO integration file passed 12/13; the independent
  source-PO search assertion remained red and is outside this three-asset
  release payload.
- Candidate JavaScript syntax, release markers, image labels, image history,
  and exact workspace-to-image hashes passed.

## Release and rollback

- Base image:
  `sha256:7df3d787f09b3395e7ed0fb7c57aad78600a18e0f9f97b5c4edd3ec851ae61ae`.
- Release image:
  `sha256:a11311d2273cb8847bc3d672de8a725264e11948d3d408ef50d83319949aba10`.
- Release tag:
  `mbbs-operator-app:po-link-inline-service-20260901T001927Z`.
- Rollback tag:
  `mbbs-operator-app:rollback-pre-po-link-inline-service-20260901T001927Z`.
- Combined source hash:
  `e4a29d7c06760ce7a81b9a22ee8a07c63f2fe6ec07bdf2ed9ba1f137afe71307`.
- Exact asset hashes:
  - `dispatch.js`: `d393ab7a569b75b4fe335f3529f86ef5c917287f608887878f79d93ce908bcdd`
  - `dispatch.css`: `4f486a3e6bcf65fb2a90bf1e3410579eb2dcf3692c7e1053ad0004291de909bc`
  - `dispatch.html`: `fe2399e04518a4597e34069d75a77b6621917e3083d97c9697ddad4c16d72913`

## Cutover and live acceptance

- Only the `app` service was recreated through a health-gated short cutover;
  the command completed in 10.1 seconds.
- PostgreSQL, Ollama, and the webhook worker retained their prior containers
  and start times. All restart counts remained zero.
- The new app is healthy on image
  `sha256:a11311d2273cb8847bc3d672de8a725264e11948d3d408ef50d83319949aba10`
  with release label `dispatch-po-link-inline-service-v3`.
- Local and public HTTPS `/health` returned `200` with
  `{"ok":true,"app":"MBBS Yard Server"}`.
- Public `dispatch.html` references the
  `20260831-po-link-inline-service-v3` JavaScript and CSS generation.
- Public JavaScript and CSS hashes match the release image byte-for-byte and
  contain the inline `Service fee only` card controls and styling.
- Startup logs contain no error.
