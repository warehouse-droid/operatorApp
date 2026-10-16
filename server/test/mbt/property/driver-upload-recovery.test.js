import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {loadDriverHelpers} from "../../support/driver-upload-fixtures.mjs";

test("automatic recovery advances exactly for a confirmed matching stop and never repeats its write", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({matching: fc.boolean(), complete: fc.boolean()}), {maxLength: 20}),
    fc.constantFrom(0, 409, 500, 502, 503, 504),
    async (entries, status) => {
      const job = {jobId: "expected-job", planDate: "2026-10-15", status: "in_progress"};
      let writes = 0;
      const context = loadDriverHelpers({request: async (path, options) => {
        if (options?.method === "POST") {
          writes += 1;
          throw Object.assign(new Error("response lost"), {status, isNetworkError: status === 0});
        }
        return path.includes("/history") ? {records: entries.map(entry => ({
          status: entry.complete ? "complete" : "in_progress", details: {jobId: entry.matching ? job.jobId : "other-job"}
        }))} : {job};
      }});
      const action = context.saveDriverPhotoAction("/api/driver/jobs/expected-job/photos", {}, job);
      if (entries.some(entry => entry.matching && entry.complete)) {
        assert.equal((await action).reconciled, true);
        assert.equal(context.driverUploadSaveChecks.size, 0);
      } else {
        await assert.rejects(action);
        assert.equal(context.driverUploadSaveChecks.size, 1);
      }
      assert.equal(writes, 1);
    }
  ), {seed: 20261015, numRuns: 100});
});
