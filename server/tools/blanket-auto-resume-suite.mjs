import fs from "node:fs";
import {spawnSync} from "node:child_process";

export const files=[
  "src/smart-scm-planning-exclusion-repository.js","src/smart-scm-planning-repository.js",
  "src/smart-scm-blanket-repository.js","src/smart-scm-blanket-pool-repository.js","src/dispatch-repository.js","src/order-sync-repository.js",
  "public/scm-smart-exclusions.js","public/scm-smart.html"
];
export const focused=[
  "test/mbt/integration/blanket-auto-resume.test.js",
  "test/mbt/integration/blanket-auto-resume-http.test.js",
  "test/mbt/unit/blanket-auto-resume-ui.test.js"
];
export const regression=[
  "src/smart-scm-planning-exclusion-harness.js","src/smart-scm-blanket-workflow-harness.js",
  "src/smart-scm-blanket-ui-harness.js","src/smart-scm-calculation-ui-harness.js",
  "src/scm-blanket-po-harness.js","src/smart-scm-harness.js",
  "test/mbt/unit/smart-scm-blanket-residual-coverage.red.test.js",
  "test/mbt/property/smart-scm-blanket-residual-coverage.property.test.js"
];

export function runNode(args,{cwd=process.cwd(),log,env={}}={}) {
  const result=spawnSync(process.execPath,args,{cwd,env:{...process.env,...env},encoding:"utf8",maxBuffer:12*1024*1024});
  const output=(result.stdout||"")+(result.stderr||"");
  if(log)fs.writeFileSync(log,output);
  return {status:result.status,output};
}

if(process.argv[1]?.endsWith("blanket-auto-resume-suite.mjs")) {
  const artifact="test-artifacts/blanket-auto-resume";
  const commands=[
    ["focused",["--test","--test-concurrency=1",...focused]],
    ["focused-reversed",["--test","--test-concurrency=1",...focused.toReversed()]],
    ["regression",["--test","--test-concurrency=1",...regression]]
  ];
  let failed=false;
  for(const [name,args] of commands) {
    const runs=name==="focused-reversed"
      ?focused.toReversed().map(file=>runNode(["--test",file]))
      :[runNode(args)];
    const result={status:runs.some(run=>run.status!==0)?1:0,output:runs.map(run=>run.output).join("\n")};
    fs.writeFileSync(`${artifact}/${name}-final.log`,result.output);
    const failures=[...result.output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);
    const expected=name==="regression"?[
      "/app/src/smart-scm-blanket-ui-harness.js","/app/src/smart-scm-harness.js"
    ]:[];
    const matched=JSON.stringify(failures.toSorted())===JSON.stringify(expected.toSorted());
    if(!matched||(!expected.length&&result.status!==0))failed=true;
    console.log(JSON.stringify({name,status:result.status,failures,expectedBaseline:expected,matched}));
  }
  if(failed)process.exitCode=1;
}
