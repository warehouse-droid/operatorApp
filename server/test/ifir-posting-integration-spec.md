# IR/IF RESTlet application activation

Tier 3. Spec approval: not obtained (autonomous run). User authorized enabling
the new flow and enabled both NetSuite deployment parameters. No dependencies,
schema changes or commits are planned. Use the existing isolated Compose budget,
Node test runner, fast-check, TypeScript, ESLint and c8; retain evidence, remove
all disposable test resources. Deploy a scoped overlay of the current live image
with rollback, preserving unrelated concurrent work and configuration.

Failure model and acceptance tests:

1. Four allowed transforms use deployment 507 and return the actual saved number
   and record. The operator processor, automatic SO fulfillment and split IF
   parts verify returned evidence without another HTTP record read on success.
2. Receipt source/charge evidence comes from the authenticated RESTlet response;
   mismatch in quantities, IDs, source, external ID, units, version or completion
   prevents finalization. Missing or malformed responses enter recovery.
3. The transport sends one POST per attempt, has no automatic POST retry, and
   never falls back after a timeout, ambiguous save or malformed success. Known
   transaction IDs survive errors. Existing leases, external-ID recovery and
   split-part duplicate prevention remain in force.
4. Disabled configuration and unsupported payloads (kits, explicit inventory
   assignments, mixed-location combined SO fulfillment) retain native posting.
   A script rejection may use native posting only for a documented unsupported
   case with explicit proof no save was attempted and no transaction ID exists.
5. URLs must use HTTPS, the configured account's RESTlet host and exact path,
   with script/deployment only; redirects are rejected. Credentials stay server
   side. Invalid URL/auth setup fails before POST.
6. Activation uses an explicit feature gate, default off. The authorized rollout
   configures account 6518947, script 507/deploy 1 and enables the gate. It can be
   disabled with NETSUITE_IFIR_POSTING_ENABLED=false and does not enable direct access
   for mirror consumers. A live GET must confirm both deployment flags before
   rollout. Verification does not create a production test transaction.
7. Existing posting, auto-fulfillment, kit, charge and split-location tests must
   have no new failures. Use property tests and deliberate mutants for identity,
   duplicate prevention and returned-record consumption; report limits honestly.

Deploy only after the scoped candidate tests pass; check app health and exact
runtime source hashes. No arbitrary real orders will be posted to test rollout.

User additions: retain the old flow behind the feature gate, and replay existing
history before activation. Live replay must first read and verify the recorded
transaction ID, external ID, source and document number; require outcome=existing
and unchanged identity. Include packs and kit history, inspect discount/special
source lines, and preserve native routing for cases the script cannot verify.

Evidence-driven clarification: the live native API and RESTlet both omit the four
package columns on Item Receipts IR15201/IR15204; these columns exist on Item
Fulfillments. Do not invent receipt package values or require unavailable columns
to finalize receipts. Preserve the existing receipt quantity/unit/item verification,
and additionally require requested package fields to match on IF. Kits must route
native: historical kit IF158771 fails the script's complete-readback check.
Transport failure clarification: any rejected POST, including a non-Error rejection,
must require reconciliation and must never return the native-fallback sentinel.
The transport boundary will be tested with null and string rejections; a throwaway
mutant will prove that silently returning native fallback is detected.
