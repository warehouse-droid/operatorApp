# Sales units govern pickup allocation

User authority: investigate GOB-122647-122650-122835-123218, remove the empty
3445 pickup even though the driver pressed continue, and always use sales
units for allocation; packing converts to sales units rather than creating
another quantity balance. Tier 3; spec approval not separately obtained
(autonomous run). No dependency, schema, external write, or commit is planned.

Acceptance:

1. A line with 271.25 SQFT / 5 pallets, all 271.25 allocated to Techo, has
   zero pickup cargo at 3445 even if cached allocated pallets are zero.
2. Sales quantity remaining is max(total - PO - direct allocation, 0).
   Packing displayed at that pickup represents the same fraction of the
   line, never an independent remainder. Explicit zero sales quantity means
   no cargo. Legacy lines with no sales quantity retain their known packing.
3. Browser hover, required-pickup validation, and driver pickup items agree
   for full, partial, zero and excessive allocations, repeated item IDs,
   groups and mixed packing; quantities are conserved and inputs unchanged.
4. The one-off repair verifies live active allocations and empty recorded
   cargo, removes only the identified 3445 stop, preserves all other stops,
   load identities, cargo, PO links and driver progress. The continue record
   is superseded with its original timestamps and payload retained in audit.
5. Repair owns the fleet lock, fences the revision, archives the prior plan,
   updates projections atomically, is idempotent and rolls back on failure.
   No general permission to remove executed stops is introduced.
6. Deploy only the tested runtime overlay on the captured live image. Preserve
   SOR fixes, configuration and other services; verify live route and health.

Failure model: stale packing invents cargo (regressions/properties); a real
partial pickup vanishes (positive residual cases); one repair affects other
execution (exact before/after comparison); concurrency or partial failure
(fleet lock, revision refusal, rollback integration); stale browser assets
(cache version and deployed asset hashes). Use bounded disposable Compose,
record coverage/mutations/static checks and concise evidence; remove all test
containers, volumes, networks and artifacts after every run.

Acceptance clarification after the first broad run: the existing save-refresh
fixture explicitly expected stale physical allocations to create a false
source-yard requirement before save hydration. Under the user's sales-unit
rule, that intermediate requirement must also be absent. Its three scenario
setups now assert vendor-only requirements and no conflict; their full,
partial, cancelled-link, rollback and idempotence assertions stay intact.

Operator clarification from the user's 200-unit example:

7. 200 sales units with 100 active PO units leaves 100 for Operator. The same
   applies to 100 direct-to-customer TO units, or 60 PO + 40 direct TO units.
   A yard-replenishment TO does not reduce outbound yard work. Cancelled links
   do not consume sales units. Loaded units reduce the remaining yard balance.
8. Fully linked converted lines must also show no yard work, even with stale
   packing annotations. Browser and server must retain a projected zero sales
   residual instead of converting reference packing back into a requirement.
   Legacy physical-only lines retain their compatibility behavior. The prior
   converted-line test explicitly expected false no-yard status; that assertion
   changes under the user's sales-authority requirement. Physical annotations
   remain available as reference; inventory posting ownership stays unchanged.
