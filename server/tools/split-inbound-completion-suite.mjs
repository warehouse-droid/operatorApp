import fs from "node:fs";
import {spawnSync} from "node:child_process";

export const files=["src/smart-scm-split-inbound-sql.js","src/smart-scm-planning-repository.js",
  "src/smart-scm-proposal-editor.js","src/smart-scm-vendor-repository.js"];
export const focused=["test/mbt/integration/split-inbound-completion.test.js"];
export const regression=[
  "test/mbt/unit/smart-scm-phased-planning.red.test.js",
  "test/mbt/unit/smart-scm-blanket-split-inventory.red.test.js",
  "test/mbt/integration/smart-scm-phased-settings.test.js",
  "test/mbt/integration/scm-split-receipt-allocation.red.test.js",
  "test/mbt/integration/blanket-auto-resume.test.js",
  "src/smart-scm-authoritative-inbound-harness.js",
  "src/smart-scm-authoritative-inbound-integration-harness.js",
  "src/smart-scm-vendor-alternative-harness.js",
  "src/smart-scm-blanket-workflow-harness.js",
  "src/smart-scm-harness.js"
];

export function runNode(args,{cwd=process.cwd(),log,env={}}={}) {
  const result=spawnSync(process.execPath,args,{cwd,env:{...process.env,...env},encoding:"utf8",maxBuffer:12*1024*1024});
  const output=(result.stdout||"")+(result.stderr||"");
  if(log)fs.writeFileSync(log,output);
  return {status:result.status,output};
}

if(process.argv[1]?.endsWith("split-inbound-completion-suite.mjs")) {
  const artifact="test-artifacts/split-inbound-completion";
  const baseline=process.argv.includes("--baseline");
  const groups=baseline?[["baseline",regression],["baseline-reversed",[...regression].reverse()]]:[["focused",focused],["regression",regression],["reversed",[...regression,...focused].reverse()]];
  const failuresOf=output=>[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]).sort();
  const expected=baseline?[]:JSON.parse(fs.readFileSync(`${artifact}/baseline-failures.json`,"utf8"));
  for(const [name,tests] of groups) {
    const runs=name.includes("reversed")?tests.map(file=>runNode(["--test",file])):[runNode(["--test","--test-concurrency=1",...tests])];
    const output=runs.map(r=>r.output).join("\n");
    fs.writeFileSync(`${artifact}/${name}.log`,output);
    const failures=failuresOf(output);
    if(baseline)fs.writeFileSync(`${artifact}/${name}-failures.json`,JSON.stringify(failures));
    const expectedHere=name==="reversed"?JSON.parse(fs.readFileSync(`${artifact}/baseline-reversed-failures.json`,"utf8")):expected;
    const matched=baseline||JSON.stringify(failures)===JSON.stringify(name==="focused"?[]:expectedHere);
    console.log(JSON.stringify({name,failures,matched}));
    if(!matched)process.exitCode=1;
  }
}
