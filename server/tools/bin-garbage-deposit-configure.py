#!/usr/bin/env python3
"""Apply the user-authorized CAD500 deposit once, preserving operational evidence."""
import json,runpy,sys
from pathlib import Path

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'deployments/bin-planning-corrections-20261023'
base=runpy.run_path(str(SERVER/'tools/bin-selection-release.py'))

def configuration():
    return json.loads(base['db']("""SELECT coalesce(json_agg(x),'[]'::json) FROM (
      SELECT item.item_code,version.rate_card_version_id::text,version.version_number,
        (SELECT json_agg(json_build_object('kind',r.component_kind,'amount',r.amount_minor,'basis',r.rate_basis) ORDER BY r.component_code)
           FROM mbt_rate_components r WHERE r.rate_card_version_id=version.rate_card_version_id AND r.active) AS components,
        (SELECT json_agg(json_build_object('code',d.rule_code,'type',d.rule_type,'amount',d.fixed_amount_minor,'currency',d.currency))
           FROM mbt_deposit_rules d WHERE d.rate_card_version_id=version.rate_card_version_id AND d.active) AS deposits
      FROM mbt_rate_cards card JOIN mbt_rate_card_versions version USING(rate_card_id)
      JOIN mbt_local_item_settings item ON item.item_code=card.item_code
        OR (card.item_code IS NULL AND EXISTS (SELECT 1 FROM mbt_rate_components rental
          WHERE rental.rate_card_version_id=version.rate_card_version_id AND rental.active
            AND rental.component_kind='rental' AND rental.item_code=item.item_code))
      WHERE item.item_type='bin' AND item.active AND card.active AND version.status='active'
      ORDER BY item.item_code) x;"""))

def configure():
    deployed=json.loads((OUT/'deployment.json').read_text())
    assert base['metadata'](base['APP'])['imageId']==deployed['imageId'],'Live image changed'
    validation=json.loads((OUT/'validation.json').read_text())
    assert validation['passed'],'Deposit correction must pass validation before activation'
    for file,digest in validation['gauntlet']['operationalSourceHashes'].items():
        assert base['sha'](SERVER/file)==digest,'Validated deposit script changed: '+file
    path=OUT/'deposit-command.json'
    if path.exists():
        saved=json.loads(path.read_text())
    else:
        before=configuration()
        assert len(before)==2 and {r['item_code'] for r in before}=={'14YD','20YD'},'Active BIN items changed; review the rate scope'
        assert all(not r['deposits'] for r in before),'A deposit is already configured; review instead of overwriting'
        saved={'before':before,'input':{'actor':{'operatorId':'codex-user-request-20261023','roles':['admin']},
          'idempotencyKey':'garbage-bin-deposit-500-20261023','correlationId':'garbage-bin-deposit-500-20261023',
          'requestId':'garbage-bin-deposit-500-20261023','amountMinor':50000,
          'versionIds':[r['rate_card_version_id'] for r in before]}}
        base['save'](path,saved)
    source=(SERVER/'tools/bin-garbage-deposit-rates.mjs').read_text().replace("'../src/","'/app/src/")
    source+="\nimport {closeDb} from '/app/src/db.js';\n"
    source+="try { const result=await configureGarbageDeposits("+json.dumps(saved['input'])+"); console.log(JSON.stringify(result)); } finally { await closeDb(); }\n"
    output=base['docker']('exec','-i',base['APP'],'node','--input-type=module',data=source.encode())
    result=json.loads(output.splitlines()[-1])
    base['save'](OUT/'deposit-configuration-audit.json',result)
    verify()

def verify():
    before=json.loads((OUT/'deposit-command.json').read_text())['before']
    current=configuration()
    assert [r['item_code'] for r in current]==[r['item_code'] for r in before]
    for old,new in zip(before,current):
        assert new['components']==old['components'],'Rental/extension charges changed'
        assert new['deposits']==[{'code':'garbage_bin_deposit','type':'fixed','amount':50000,'currency':'CAD'}]
    base['save'](OUT/'deposit-verification.json',{'passed':True,'activeRates':current,'rentalAndExtensionRatesPreserved':True})
    print(json.dumps({'verified':True,'depositCad':500,'binItems':[r['item_code'] for r in current]}))

if __name__=='__main__': {'configure':configure,'verify':verify}[sys.argv[1]]()
