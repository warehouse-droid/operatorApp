"""Read-only probe of the candidate reader using the running app's NetSuite auth."""
from pathlib import Path
import base64
import json
import subprocess

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/field-sales/trade'
pricing = (SERVER / 'public/field-sales/pricing.js').read_text().replace("'./domain.js'", "'file:///app/public/field-sales/domain.js'")
pricing_uri = 'data:text/javascript;base64,' + base64.b64encode(pricing.encode()).decode()
reader = (SERVER / 'src/field-sales/netsuite-catalog.js').read_text().replace("'../netsuite.js'", "'file:///app/src/netsuite.js'").replace("'../../public/field-sales/domain.js'", "'file:///app/public/field-sales/domain.js'").replace("'../../public/field-sales/pricing.js'", json.dumps(pricing_uri))
uri = 'data:text/javascript;base64,' + base64.b64encode(reader.encode()).decode()
script = """import {closeDb} from './src/db.js';
const {createNetSuiteCatalogReader}=await import(READER);
try{
 const reader=createNetSuiteCatalogReader(),results=[];
 for(const [company,subsidiaryId] of [['MBBS','1'],['MBR','7'],['MBT','3']]){
  const items=await reader.items(company,{subsidiaryId,currencyId:'1'});
  results.push({company,items:items.length,priced:items.filter(i=>i.unit_rate!==null).length,quantityBreaks:items.filter(i=>i.pricing.tiers.length>1).length,sample:items.filter(i=>i.unit_rate!==null).slice(0,2).map(i=>({id:i.item_id,sku:i.sku,rate:i.unit_rate,pricing:i.pricing,unit:i.unit}))});
 }
 console.log(JSON.stringify({passed:true,readOnly:true,results}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{await closeDb();}
""".replace('READER',json.dumps(uri))
r = subprocess.run(['docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module'],input=script,text=True,capture_output=True)
OUT.mkdir(parents=True,exist_ok=True)
(OUT / 'live-reader-probe.log').write_text(r.stdout+r.stderr)
if r.returncode == 0:
    (OUT / 'live-reader-probe.json').write_text(r.stdout)
print(r.stdout+r.stderr)
raise SystemExit(r.returncode)
