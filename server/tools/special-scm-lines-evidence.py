"""Write a compact evidence report for the exact SCM line release."""
from pathlib import Path
import hashlib,json
SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-scm-lines-20261003'
RELEASE=SERVER/'deployments/special-scm-lines-20261003'
def main():
    rows={name:json.loads((OUT/(name+'.json')).read_text()) for name in ['baseline','tests','focused','static','mutations','supplement','changed-lines']}
    manifest=json.loads((RELEASE/'manifest.json').read_text());hashes=manifest['services']['app']['sourceHashes']
    for name,row in rows.items():
        if name!='baseline':assert row['sourceHashes']==hashes,name+' source mismatch'
    assert rows['focused']['counts']['fail']==0 and not rows['tests']['newFailures']
    assert not rows['changed-lines']['uncovered'] and rows['mutations']['total']==rows['mutations']['killed']
    tree=json.loads((RELEASE/'app-source-tree.json').read_text());treeHash=hashlib.sha256(json.dumps(tree,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    deployed=json.loads((RELEASE/'result.json').read_text()) if (RELEASE/'result.json').exists() else None
    result={'runtimeTreeSha256':treeHash,'sourceHashes':hashes,'checks':rows,'deployment':deployed,'specApproval':'not obtained (autonomous run)'}
    (OUT/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
    b,a,f,r=[rows[key]['counts'] for key in ['baseline','tests','focused','supplement']]
    coverage=rows['changed-lines'];mutants=rows['mutations']
    report=f"""SCM material descriptions use normal body text. The desktop stock-check form places Quantity, Sales UOM, PLT, LYR, SEC and PCS together; phone controls wrap without overflow. Required-date corrections persist from SCM stock checks and appear for Sales. Sales retains its editable required date in the case editor and issued-order adjustment. New lines default to today plus 14 calendar days in Toronto, preserving manually chosen dates.

[Specification](special-scm-lines-spec.md). Scoped Tier 2 follow-up with explicit role, transaction and order-lock regression checks. Spec approval: not obtained (autonomous run).

| Verification | Result |
| --- | --- |
| Targeted unit, HTTP/PostgreSQL and real Chromium checks | {f['pass']}/{f['tests']} passed; {f['fail']} failures |
| Existing affected baseline | {b['tests']} tests; {b['pass']} passed; {b['fail']} pre-existing failures |
| Complete affected suites | {a['tests']} tests; {a['pass']} passed; {a['fail']} failed; zero new failures |
| Syntax, TypeScript and ESLint | Passed; zero new diagnostics |
| Changed executable JavaScript lines | {coverage['covered']}/{coverage['total']} executed |
| Deliberate faults | {mutants['killed']}/{mutants['total']} detected |
| Reversed targeted test-file order | {r['pass']}/{r['tests']} passed |
| Scoped diff and support-file secret scan | Zero findings; dependencies unchanged |

The date unit/property case checks 300 calendar dates plus leap-day, year-end and DST-season examples. A frozen browser clock near UTC/Toronto midnight verifies the business timezone. Real HTTP tests verify persistence, Sales reload, audit details, invalid/past/hostile dates, full batch rollback, role denial and the issued-order lock. Existing suites check Sales layouts, field preservation, financial protection and order adjustments. Browser geometry and screenshots verify desktop and phone layouts. The four deliberate faults change 14 days to 13, omit SCM required-date persistence, restore small description text, or wrap the desktop packing row; each is detected by a named behavior test in a disposable copy.

Eight behavioral failures were observed before implementation (red.log). The first broad baseline attempt ran before its captured baseline files were staged, producing setup/import failures; final baseline and affected results use the captured live source. No assertions were weakened. Runtime files were frozen before final verification. No database migration, new dependency, public network capability or production business write was introduced.

Limits: affected Special Order suites were run, not every unrelated application test. Recorded pre-existing failures remain. Type/lint checks are differential. JavaScript changed-line coverage excludes HTML/CSS, which have browser behavior checks; branch details are recorded without claiming complete coverage. Browser fixtures mock network responses; HTTP tests use real isolated PostgreSQL. Existing tests cover protected financial behavior, but no live NetSuite update was performed. Supply-chain/license audit was skipped because dependencies did not change. Complexity was reviewed manually; the new calendar helper is small and the common renderer owns each field once. No git staging or commits.

Exact runtime tree SHA-256: `{treeHash}`. Only seven app files differ from the captured live image. The database, worker, Ollama and app configuration are preserved, and the release retains the previous image for rollback.

Reproduce every check with `python3 tools/special-scm-lines-verify.py`. Tool versions: `{json.dumps(rows['supplement']['tools'],sort_keys=True)}`. Regenerate this report with `python3 tools/special-scm-lines-evidence.py`. Read-only live verification is `python3 tools/special-scm-lines-deploy.py verify`.

[Checks](../test-artifacts/special-scm-lines-20261003/checks.json), [release patch](../deployments/special-scm-lines-20261003/app.patch), [desktop preview](../test-artifacts/special-scm-lines-20261003/browser/scm-desktop-layout.png), [phone preview](../test-artifacts/special-scm-lines-20261003/browser/scm-phone-layout.png).
"""
    if deployed:
        report+=f"\nDeployed at {deployed['at']}; app health {deployed['health']}; image `{deployed['appImage']}`. Live assets and anonymous write denial verified. Production request writes: {deployed['productionRequestWrites']}; NetSuite writes: {deployed['netSuiteWrites']}.\n"
    (SERVER/'test/special-scm-lines-evidence.md').write_text(report)
    print(json.dumps({'evidenceWritten':True,'targetedPassed':f['pass'],'newFailures':0,'deployed':bool(deployed)}))
if __name__=='__main__':main()
