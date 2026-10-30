#!/usr/bin/env python3
"""Apply the user's 60,000 lb 14YD payload setting with revision fencing."""
import datetime,json,runpy,sys,uuid
from decimal import Decimal,ROUND_FLOOR
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('transport-errors-release.py')))
base=release['base'];out=release['scope']['OUT'];db=base['db']
requested=60000
kilograms=int((Decimal(requested)/Decimal('2.2046226218')).to_integral_value(rounding=ROUND_FLOOR))
rows=json.loads(db("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',bin_type_id,'code',type_code,'maximumPayloadKg',maximum_payload_kg,'revision',revision)),'[]') FROM mbt_bin_types WHERE type_code='14YD' AND active;"))
assert len(rows)==1,'Expected one active 14YD bin type'
current=rows[0];uuid.UUID(current['id'])
plan_path=out/'payload-configuration-plan-audit.json'
if not plan_path.exists():
    base['save'](plan_path,{'requestedBy':'User instruction in this task','requestedPayloadLbs':requested,
        'storedMaximumPayloadKg':kilograms,'conversion':'Floor to the existing whole-kilogram field; never exceed the supplied rating.',
        'before':current})
plan=json.loads(plan_path.read_text())
assert plan['requestedPayloadLbs']==requested and plan['storedMaximumPayloadKg']==kilograms
if '--apply' not in sys.argv:
    print(json.dumps({'planned':True,'binType':'14YD','requestedPayloadLbs':requested,'storedMaximumPayloadKg':kilograms,'before':current}))
    raise SystemExit(0)
audit_path=out/'payload-configuration-audit.json'
if audit_path.exists():
    audit=json.loads(audit_path.read_text());assert current==audit['after'],'Payload setting changed after this task applied it'
    print(json.dumps({'alreadyApplied':True,'binType':'14YD','storedMaximumPayloadKg':kilograms}))
    raise SystemExit(0)
assert current==plan['before'],'The bin type changed; inspect before updating'
old=current['maximumPayloadKg'];assert old is None or isinstance(old,int)
old_sql='NULL' if old is None else str(old)
after=json.loads(db(f"""BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s';
UPDATE mbt_bin_types SET maximum_payload_kg={kilograms},revision=revision+1,
 updated_by='codex:user-request',updated_at=now()
WHERE bin_type_id='{current['id']}' AND type_code='14YD' AND active
 AND revision={int(current['revision'])} AND maximum_payload_kg IS NOT DISTINCT FROM {old_sql}
RETURNING jsonb_build_object('id',bin_type_id,'code',type_code,'maximumPayloadKg',maximum_payload_kg,'revision',revision);
COMMIT;"""))
assert after['maximumPayloadKg']==kilograms
base['save'](audit_path,{**plan,'appliedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'after':after})
print(json.dumps({'applied':True,'binType':'14YD','requestedPayloadLbs':requested,'storedMaximumPayloadKg':kilograms,'revision':after['revision']}))
