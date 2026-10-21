"""Run from the repo with Docker access. --reuse uses the existing isolated runners.

This never connects to production. Test database state stays in a dedicated tmpfs.
Coverage gaps are reported as an incomplete layer, with a nonzero final exit.
"""
import argparse,json,subprocess,time
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('--reuse',action='store_true');args=parser.parse_args()
root=Path(__file__).resolve().parents[2];out=root/'server/test-artifacts/regular-stock-v2';out.mkdir(parents=True,exist_ok=True)
compose=['docker','compose','-p','mbbs-regular-v2','-f','docker-compose.mbt-test.yml','-f','docker-compose.regular-stock-v2.yml','--profile','tools','--profile','runtime','--profile','e2e']
runner='mbbs-regular-v2-runner';browser='mbbs-regular-v2-browser'
def setup(command):subprocess.run(command,cwd=root,check=True)
if not args.reuse:
    setup(compose+['build','test','e2e'])
    setup(compose+['up','-d','--wait','db'])
    setup(compose+['run','--rm','--no-deps','migrate'])
    # Remove only the two named test runners; never touch application containers.
    subprocess.run(['docker','rm','-f',runner,browser],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for service,name in [('test',runner),('e2e',browser)]:
        setup(compose+['run','-d','--no-deps','--name',name,service,'sleep','infinity'])
layers=[]
def run(name,command,cwd=root):
    started=time.time()
    with (out/f'{name}.log').open('w') as log:result=subprocess.run(command,cwd=cwd,stdout=log,stderr=subprocess.STDOUT)
    layers.append({'layer':name,'exitCode':result.returncode,'seconds':round(time.time()-started,2)})
    print(json.dumps(layers[-1]),flush=True)
execute=lambda tool,*extra:['docker','exec',runner,'node',f'tools/{tool}',*extra]
run('static',execute('regular-stock-v2-static.mjs'))
run('tests-and-node-coverage',execute('regular-stock-v2-coverage.mjs','--collect'))
run('reverse-order',execute('regular-stock-v2-tests.mjs','--reverse'))
run('mutations',execute('regular-stock-v2-mutations.mjs'))
run('browser',['docker','exec',browser,'node','node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
    '--include=src/**','--temp-directory=/tmp/regular-stock-v2-browser-c8',
    '--report-dir=test-artifacts/regular-stock-v2/coverage-browser','--reporter=json','node','tools/regular-stock-v2-browser.mjs'])
run('changed-line-coverage',execute('regular-stock-v2-coverage.mjs','--require-complete'))
run('secrets',['python3','server/tools/regular-stock-v2-secrets.py'])
run('test-tool-lint',['docker','exec',runner,'node_modules/.bin/eslint','--config','tools/regular-stock-v2-eslint.config.mjs',
    'tools/regular-stock-v2-coverage.mjs','tools/regular-stock-v2-browser.mjs','tools/regular-stock-v2-mutations.mjs',
    'tools/regular-stock-v2-static.mjs','tools/regular-stock-v2-tests.mjs',
    'test/mbt/unit/regular-stock-domain.test.js','test/mbt/unit/regular-stock-netsuite.test.js',
    'test/mbt/property/regular-stock.property.test.js',
    *[str(path.relative_to(root/'server')) for path in sorted((root/'server/test/mbt/integration').glob('regular-stock*.test.js'))]])
(out/'gauntlet.json').write_text(json.dumps(layers,indent=2)+'\n')
raise SystemExit(0 if all(layer['exitCode']==0 for layer in layers) else 1)
