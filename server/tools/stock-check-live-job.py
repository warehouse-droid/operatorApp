"""Queue/read the explicitly authorized five-pallet Unilock pilot; never print credentials."""
import json,pathlib,subprocess,sys
server=pathlib.Path(__file__).resolve().parents[1]
prefix='import {createStockCheckRuntime} from "./src/stock-check/runtime.js";import {closeDb} from "./src/db.js";const runtime=createStockCheckRuntime({authenticate:(_r,_s,next)=>next(),dataDir:"/app/data"});const repo=runtime.repo;'
if sys.argv[1]=='queue':
    code=prefix+'try {const products=await repo.listProducts({vendorId:1,search:"0262XL0631907-0"});if(products.total!==1)throw new Error("Select the exact pilot SKU.");const job=await repo.createJob(1,{kind:"stock_test",productId:products.items[0].id,quantity:5},"authorized-unilock-live-check");console.log(JSON.stringify({jobId:job.id}));}finally{await closeDb();}'
else:
    job=json.loads((server/'test-artifacts/stock-check/live-job.json').read_text())['jobId']
    code=prefix+'try {console.log(JSON.stringify(await repo.getJob('+json.dumps(job)+')));}finally{await closeDb();}'
result=subprocess.run(['sudo','-n','docker','exec','mbbs-operator-app-app-1','node','--input-type=module','--eval',code],capture_output=True,text=True,timeout=30)
if result.returncode:raise RuntimeError('The operational Stock Check command failed.')
report=json.loads(result.stdout)
(server/'test-artifacts/stock-check'/('live-job.json' if sys.argv[1]=='queue' else 'live-result.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
