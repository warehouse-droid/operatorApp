Deployed 2026-10-26 at 19:59 UTC as `mbbs-operator-app:quote-packing-zero-20261026`.

Generated quote PDFs leave zero and missing PLT/LYR/SEC/PCS values blank.
The quote builder normalizes zero counts for presentation, and the PDF renderer
also handles numeric and text zeros in older saved snapshots. Positive packing
counts, prices, discounts, taxes and totals keep their existing values. Saved
records are not rewritten.

The four new PDF regression tests failed on the original formatter. The final
candidate passed all 42 tests across seven quote suites, including actual PDF
content checks, ancillary pallet packing, multi-page layout, Chinese text,
draft/saved quotes, discounts and zero-dollar prices. The candidate source
capture needed readable permissions for the unprivileged test container.

The built image passed source-hash and startup verification. Deployment verified
all 1,506 runtime files, preserved application configuration and dependencies,
and passed local and public health checks. Only the two quote presentation
files were included in the release; no migration was required.

All test runs used the bounded disposable runner. Containers, test volumes,
networks and temporary artifacts were removed, including after failed runs.
Both `docker ps` and `docker ps -a` showed only the four production containers.

Release checks and rollback are recorded in
`server/deployments/quote-packing-zero-20261026/`; the reusable release entry
point is `server/tools/quote-packing-zero-release.py`.
