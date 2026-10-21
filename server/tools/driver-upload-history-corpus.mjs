import fs from "node:fs";

if (process.env.MBT_TEST_ISOLATED !== "1") throw new Error("Historical corpus preparation requires the isolated test environment.");
const history = JSON.parse(fs.readFileSync("test/fixtures/driver-upload-history.json", "utf8"));
fs.writeFileSync("test-artifacts/historical-corpus.ndjson", history.jobs.map(job => JSON.stringify(job)).join("\n") + "\n");
console.log(JSON.stringify({records: history.jobs.length, fromDate: history.fromDate, toDate: history.toDate, capturedAt: history.capturedAt}));
