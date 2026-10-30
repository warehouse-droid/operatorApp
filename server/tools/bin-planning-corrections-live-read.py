#!/usr/bin/env python3
"""Read the deployed BIN search projection without creating orders or plans."""
import json
import runpy
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'deployments/bin-planning-corrections-20261023'
base = runpy.run_path(str(SERVER / 'tools/bin-selection-release.py'))

deployed = json.loads((OUT / 'deployment.json').read_text())
assert base['metadata'](base['APP'])['imageId'] == deployed['imageId'], 'Live image changed'
source = """
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {authorizeMbtPhase3Capability} from '/app/src/mbt/phase3-authorization.js';
import {getMbtBinPlanning} from '/app/src/mbt/bin-planning-read.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='15s'");
    await authorizeMbtPhase3Capability({capability:'binDispatch',pilotAuthorized:true});
    const capability={environmentEnabled:true,databaseEnabled:true,pilotAuthorized:true};
    const reports=[];
    for(const planDate of ['2026-10-23','2030-01-02']) {
      const result=await getMbtBinPlanning({planDate,search:'BIN00002D'}, {capability});
      const cards=result.pool.items.filter(card=>(card.displayReference || card.id)==='BIN00002D');
      assert.equal(cards.length,1,'The requested BIN delivery must have one search result');
      reports.push({planDate,total:result.pool.total,reference:cards[0].displayReference || cards[0].id,
        visitId:cards[0].mbt.visitId,status:cards[0].mbt.status,planned:cards[0].dispatchPlanned,
        assignedDate:cards[0].dispatchPlanDate,loadId:cards[0].dispatchLoadId});
    }
    assert.equal(reports[0].visitId,reports[1].visitId);
    const tariffs=(await query(`SELECT tariff.item_code,tariff.amount_minor::int,
      tariff.pricing_basis,tariff.unit_of_measure,tariff.currency
      FROM mbt_dump_tariffs tariff JOIN mbt_rate_card_versions version USING(rate_card_version_id)
      WHERE tariff.active AND version.status='active'
        AND tariff.item_code IN ('ASPHALT','CONCRETE','DUMPGARBAGE','SOIL') ORDER BY tariff.item_code`)).rows;
    assert.deepEqual(tariffs.map(t=>[t.item_code,t.amount_minor,t.pricing_basis,t.unit_of_measure,t.currency]),[
      ['ASPHALT',30000,'per_quantity','BIN','CAD'],['CONCRETE',30000,'per_quantity','BIN','CAD'],
      ['DUMPGARBAGE',12000,'per_weight','TONNE','CAD'],['SOIL',30000,'per_quantity','BIN','CAD']]);
    return {readOnly:true,crossDateSearch:true,reports,dumpRatesPreserved:true,tariffs};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
"""
output = base['docker']('exec', '-i', base['APP'], 'node', '--input-type=module', data=source.encode())
result = json.loads(output.splitlines()[-1])
base['save'](OUT / 'live-search-verification.json', result)
print(json.dumps(result))
