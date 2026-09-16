# SO Delivery cleanup — authorized application, 2026-09-15

## Authorization and scope

The user explicitly requested an isolated test container, applying the cleanup,
and checking today's Driver PWA, Operator PWA, and Dispatch workflows.
This extends the earlier read-only cleanup and fulfilled-SO planning specifications.
Spec approval: not obtained (autonomous run); application itself is explicitly authorized.

Use the existing Docker/Postgres/Node/test dependencies. Add no dependencies or
migrations. Preserve other workspace work by applying the reviewed planning patch
to the exact deployed source. Retain the previous image and a full database dump.
Restore the dump into an internal Docker network with no production credentials,
no external connectivity, and no running background workers. Never execute a
NetSuite write or a simulated Driver action against production.

## Executable acceptance criteria

1. A verified F/G NetSuite Delivery SO, or its durable active split, becomes
   Operator `loaded` / `Loaded`; active pickable lines satisfy the current
   Operator-required quantities after linked supply, preserving higher loads.
2. A locally completed Driver dropoff (including the existing exact family
   completion rules) also becomes Loaded. Pickup alone does not qualify.
   Local-only completion never changes NetSuite status or creates false NetSuite evidence.
3. Refresh cached F/G status only from the verified matching positive NetSuite ID.
   Add missing Dispatch completion as NetSuite observation evidence, with the
   observation time distinguished from the unknown physical delivery time.
4. NetSuite-only completed SOs remain eligible for Dispatch planning. Locally
   delivered SOs stay blocked. Existing cancellation, split retirement, reload,
   duplicate identity, and reconciliation restrictions remain effective.
5. Do not change held, unverified, unfinished, or Pick-Up orders, commercial
   quantities/UOMs, linked allocations, Driver records/photos, plans, immutable
   completion history, or external posting queues.
6. Hold active drafts/consolidation claims, cancelled/held orders, reloads,
   conflicting loaded UOMs, packed inactive/exception lines, and excessive allocations.
7. Apply an explicitly reviewed manifest in one transaction under existing
   Dispatch and Operator locks. Revalidate before-images and supporting evidence;
   stale or forged manifests abort without partial writes. A repeat applies zero changes.
8. Rehearse the actual production snapshot and compare before/after independently.
   Verify real Operator detail/feed reads, Dispatch admission/search, and today's
   Driver routes. Perform workflow writes only inside the isolated copy.
9. Verify live application health, served assets, all applied rows, held rows,
   and today's operations after deploying the tested rule and applying cleanup.

## Evidence layers

New cleanup tests first fail against an explicit unimplemented stub. Run focused
integration and property tests, rollback/stale/concurrency checks, changed-line
coverage and manual mutation tests, static checks, and the existing relevant
Dispatch/Operator/Driver regressions. The prior planning-rule full-suite baseline
remains recorded separately. Report unavailable or incomplete layers explicitly.

## Scope amendment from subsequent user instructions

- Skip reconciliation for all 13 review orders; leave them unchanged.
- Narrow SO application to Delivery SOs still unfinished locally. Interpret local
  completion conservatively as either Operator Loaded/Shipped/fulfilled or Driver
  delivery completion. Pending clarification, the common subset contains 222 SOs
  in the 15:22 snapshot. No broad 1,592-order transaction will be applied live.
- Include unfinished COs when their exact source has verified completion. A group
  needs every source member completed; unresolved/ambiguous source identities,
  the 13 skipped source orders, reloads, and active Operator work remain excluded.
- A loaded CO displays Loaded with no open quantity in Operator; preserve its
  stored commercial/receiving quantities and Dispatch planning state. Use the
  existing `planned` CO lifecycle after load, retaining observed completion
  evidence separately from an unknown physical loading timestamp. Do not invent
  Driver evidence or append external posting work for a CO.

## Final scope clarification

The user answered the pending question: **Not delivered by a Driver in Dispatch
— exclude all locally delivered SOs.** This supersedes the temporary intersection
assumption above. Final CLI scope is `no-local-delivery`; Operator Shipped/Loaded
alone does not exclude an SO. Already consistent rows receive no unnecessary
updates. COs may still use a locally completed source as evidence.

## Direct local-completion path

The user subsequently confirmed locally delivered SOs should directly be treated
as Loaded. Apply two disjoint manifests: `no-local-delivery` uses NetSuite facts;
`local-delivery-only` aligns Operator quantities/status only, preserving every
NetSuite field and completion event. Both preserve the 13 agreed review exclusions.

## Grouped CO correction after live feedback

The user reported `CO-GOA-5381-5391` and `CO-GOB-119005-119006` still Open.
Both COs retain their exact source-group identity and member identities in their
stored creation details. All four constituent SOs have authoritative completion.
The first legacy group is retired; the second exists in the newer global registry.

For a grouped SO CO, use the members recorded on that CO when its source ID,
source type, unique member IDs and any stored child-detail identities agree. Older
COs need not have optional full child cards if their exact member IDs were recorded. Verify every
member against current source completion, preserving the 13 exclusions and all
existing per-source restrictions. Do not trust completion labels in old snapshots
or infer members by parsing a group name. Invalid or conflicting recorded identities
remain excluded. Retired or missing group definitions do not invalidate a complete
historical CO with this recorded identity evidence. Source groups stay retired and
Driver replanning restrictions stay effective. Preserve every CO cargo/receiving
line, source SO, Driver record and plan. Recheck the other skipped grouped COs for
the same omission, rehearse qualifying corrections in isolation, then apply and
verify their real Operator detail and active-feed behavior.
