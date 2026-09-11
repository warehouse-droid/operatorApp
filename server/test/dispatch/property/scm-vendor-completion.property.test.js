import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { normalizeScmVendorCompletion } from "../../../src/scm-vendor-completion.js";

test("authorized Vendor command identities normalize without changing the target",()=>{
  fc.assert(fc.property(fc.constantFrom("PO","TO","VRMA"),fc.constantFrom("admin","scm","scm_staff"),fc.integer({min:1,max:10000000}),
    (kind,role,n)=>{
      const result=normalizeScmVendorCompletion({orderKind:` ${kind.toLowerCase()} `,orderRef:` PO-${n} `,
        actor:{id:`actor-${n}`,roles:[role.toUpperCase()]},expectedUpdatedAt:"2026-09-10T12:00:00.123456Z"});
      assert.equal(result.kind,kind);assert.equal(result.ref,`PO-${n}`);assert.equal(result.actorId,`actor-${n}`);
    }),{numRuns:200,seed:197});
});
test("unauthorized roles cannot gain completion access through alternate casing or whitespace",()=>{
  fc.assert(fc.property(fc.constantFrom("dispatcher","driver","operator","sales","yard_manager",""),fc.boolean(),(role,upper)=>{
    assert.throws(()=>normalizeScmVendorCompletion({orderKind:"PO",orderRef:"PO-1",actor:{id:"actor",role:` ${upper?role.toUpperCase():role} `},
      expectedUpdatedAt:"2026-09-10T12:00:00Z"}),error=>error.status===403);
  }),{numRuns:100,seed:198});
});
