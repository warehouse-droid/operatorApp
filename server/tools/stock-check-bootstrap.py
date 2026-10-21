"""Save authorized vendor credentials and initial public metadata without plaintext files or command arguments."""
import getpass,json,pathlib,subprocess,sys
server=pathlib.Path(__file__).resolve().parents[1]
products=json.loads(pathlib.Path(sys.argv[1]).read_text())
credentials={'username':getpass.getpass('Unilock login ID (hidden): '),'password':getpass.getpass('Unilock password (hidden): ')}
source=(server/'tools/stock-check-bootstrap.mjs').read_text()
try:
    result=subprocess.run(['sudo','-n','docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module','--eval',source],
      input=json.dumps({'products':products,'credentials':credentials}),text=True,capture_output=True,timeout=120)
    if result.returncode: raise RuntimeError('Unilock setup failed. No credential contents were printed.')
    report=json.loads(result.stdout)
    (server/'test-artifacts/stock-check/bootstrap.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)
finally: credentials['password']=None
