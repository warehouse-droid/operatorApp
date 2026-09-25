"""Back up/remove only the explicitly authorized production enquiry, with compare-and-delete."""
import argparse, hashlib, json, os, pathlib, subprocess, datetime
ROOT = pathlib.Path('/home/ubuntu/operatorapp-investigations/special-workflow-20260924/private')
TABLES = ['sales_special_stock_lines','sales_special_stock_order_lines','sales_special_stock_handoffs','sales_special_stock_media','sales_special_stock_events','sales_stock_request_lines','sales_stock_request_events','sales_stock_transfers']
parts = ["'request',(SELECT to_jsonb(r) FROM sales_stock_requests r WHERE id=17)", "'case',(SELECT to_jsonb(s) FROM sales_special_stock_cases s WHERE request_id=17)"]
parts += [f"'{table}',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM {table} t WHERE request_id=17),'[]'::jsonb)" for table in TABLES]
SQL = 'SELECT jsonb_build_object(' + ','.join(parts) + ')::text AS payload'
def validate(snapshot):
    r, c = snapshot['request'], snapshot['case']
    if not r or not c or (r['id'],r['request_ref'],r['revision'],r['request_type']) != (17,'SPREQ-000001',2,'special'):
        raise ValueError('The authorized request identity or revision changed')
    if any(c.get(k) is not None for k in ['sales_order_netsuite_id','purchase_order_netsuite_id','sales_order_operation_id','purchase_order_operation_id']):
        raise ValueError('An order or operation now exists')
    if any(c[k] != 'idle' for k in ['sales_order_operation_status','purchase_order_operation_status']):
        raise ValueError('A remote operation is unresolved')
    if c['close_status'] != 'active' or len(snapshot['sales_special_stock_lines']) != 1:
        raise ValueError('The request state changed')
    for table in ['sales_special_stock_order_lines','sales_special_stock_handoffs','sales_special_stock_media','sales_stock_transfers','sales_stock_request_lines']:
        if snapshot[table]: raise ValueError(f'Dependency exists: {table}')

def run(mode, expected=None):
    code = "import {pool} from './src/db.js'; import crypto from 'node:crypto'; const c=await pool.connect(); try {\n"
    code += "await c.query('BEGIN" + (" READ ONLY" if mode=='backup' else "") + "'); await c.query(\"SET LOCAL statement_timeout='5s'\");\n"
    if mode=='delete':
        code += "await c.query('SELECT id FROM sales_stock_requests WHERE id=17 FOR UPDATE'); await c.query('SELECT request_id FROM sales_special_stock_cases WHERE request_id=17 FOR UPDATE');\n"
    code += f"const payload=(await c.query({json.dumps(SQL)})).rows[0].payload;\n"
    if mode=='delete':
        code += f"if(crypto.createHash('sha256').update(payload).digest('hex')!=={json.dumps(expected)}) throw new Error('Backup no longer matches the locked request; nothing removed');\n"
        code += "const removed=await c.query(\"DELETE FROM sales_stock_requests WHERE id=17 AND request_ref='SPREQ-000001' AND request_type='special' AND revision=2 RETURNING id\"); if(removed.rowCount!==1) throw new Error('Identity changed; nothing removed'); await c.query('COMMIT'); console.log(JSON.stringify({removedId:17,requestRef:'SPREQ-000001',backupSha256:"+json.dumps(expected)+"}));\n"
    else: code += "console.log(payload); await c.query('ROLLBACK');\n"
    code += "} catch(e) { await c.query('ROLLBACK'); throw e; } finally {c.release();await pool.end();}"
    return subprocess.run(['sudo','-n','docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module'],input=code,text=True,capture_output=True,check=True).stdout.strip()

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--delete',type=pathlib.Path); args=parser.parse_args()
    ROOT.mkdir(parents=True,exist_ok=True); ROOT.chmod(0o700)
    if args.delete:
        source=args.delete.resolve()
        if source.parent != ROOT: raise ValueError('Use a private backup produced by this tool')
        data=source.read_bytes(); validate(json.loads(data))
        sha=hashlib.sha256(data).hexdigest(); result=run('delete',sha)
        receipt=ROOT/'SPREQ-000001-deletion-receipt.json'
        fd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as file: file.write(result+'\n'); file.flush(); os.fsync(file.fileno())
        print(result)
    else:
        data=run('backup').encode(); validate(json.loads(data))
        name=ROOT/('SPREQ-000001-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
        fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as file: file.write(data); file.flush(); os.fsync(file.fileno())
        print(json.dumps({'backup':str(name),'sha256':hashlib.sha256(data).hexdigest(),'validated':True}))
if __name__=='__main__': main()
