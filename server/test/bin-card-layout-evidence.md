# MBT order-card height — 2026-10-23

The scrollable grid compressed seven populated cards to 128px tall; their contents
extended up to 181.375px below the card borders. MBT-specific `grid-auto-rows:
max-content` now gives each card enough height. The stylesheet cache key changed.

Verified the actual candidate CSS in Chromium at 1500×1000, 1200×800, 900×700,
480×800 and 375×800. Seven waiting/ready cards and the unlocked Collection search
result had zero vertical or horizontal content overflow in all ten observations.
The existing final-collection browser scenario passed: red waiting state, disabled
dragging, route editing, completion refresh, subsequent drag and saved plan. No
permanent tests or application JavaScript changed; temporary DOM inspection ran
inside the standard bounded disposable runner and was removed after each run.

Deployed `mbbs-operator-app:bin-card-layout-20261023` over the prior final-collection
release. Both runtime files and the served stylesheet match the validated candidate;
the new HTML cache key and application health were checked. Configuration and other
services were preserved. Operational validation/deployment records are under
`server/deployments/bin-card-layout-20261023`; the previous image is retained for
rollback. Final `docker ps` and `docker ps -a` contain only the four production
containers; disposable databases, volumes, networks, logs and browser artifacts
were removed. Public-edge authenticated browser access was not independently
verified; browser behavior used an isolated app and live asset checks used origin HTTP.
