#!/usr/bin/env python3
"""Release: each Admin tab loads only its own data when it is opened, and the Audit Log searches only
when Apply (or Refresh) is clicked.

2026-11-06 22:00 UTC: /admin/sync took 20-30 s to show. public/control.js loaded the data of every
Admin tab in one Promise.all before the first render, on every Admin page, including the Audit Log
search with the filters remembered in localStorage. The remembered Order # filter SOA11033 made that
search hit the 30 s audit timeout (AUDIT_QUERY_TIMEOUT at 21:46:39, 21:47:25, 22:04:41), so every tab
waited ~30 s, and each attempt held one of the app's database connections for 30 s. The sync tab's
own requests took 0.2-0.7 s. (Measured read-only: that order search takes 21 s over 30 days and 1.9 s
over 7 days; making order searches fast is a separate server change.)

Changes (live copy plus exactly EDITS):
  public/control.js
    * loadControlData on an Admin page loads only the active tab's data (ADMIN_SECTION_DATA):
      dashboard = accounts, sync settings, photo storage, Maps usage, return settings;
      Accounts = accounts, aggregate access, public sales; Sync = sync settings, M2M, env, mirror;
      Maps usage; Reconciliation; Return automation = return + notification settings;
      Photo storage; Performance (loads in the background as before); Audit Log and SOR auto-returns
      load nothing up front. Save/refresh actions that call loadControlData reload only that tab.
    * Opening another tab (sidebar, dashboard card, back/forward) loads that tab's data then.
    * The Audit Log keeps its remembered filters but runs no search (records, filter choices,
      resources chart) until Apply / Refresh / a drill-down is clicked, and says so until then.
    * The dashboard Audit Log card no longer shows a record count (no search runs there).
  public/admin.html  control.js cache version adminLazy=20261106-1.
No server or database change; an app rollback restores the previous behaviour.

Steps: patch -> prepare -> quick (optional) -> validate -> build -> deploy (verifies; rolls the app
back on failure) -> verify.
"""
import json,os,runpy,signal,subprocess,sys,time
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/admin-lazy-tabs-20261106'
PATCH=OUT/'change.patch'
# Kept beside the tool: server/deployments is subject to copy retention, tools/ is not.
CODE_PATCH=Path(__file__).with_name('admin-lazy-tabs-release.code.patch')
FILES=['public/control.js','public/admin.html']
IMAGE='mbbs-operator-app:admin-lazy-tabs-20261106'
ROLLBACK='mbbs-operator-app:admin-lazy-tabs-rollback-20261106'
TARGET_FILES=['test/admin-lazy-tabs/admin-lazy-tabs.browser.test.js']
EXPECTED_TARGET=3
T='test/admin-lazy-tabs/admin-lazy-tabs.browser.test.js :: '
NEW_TESTS={T+name for name in (
  '/admin/sync loads only the sync tab data and never the Audit Log',
  'another Admin tab loads its own data when it is clicked',
  'the Audit Log searches only when Apply is clicked')}
REGRESSION=['test/resource-monitor/resource-chart.browser.test.js','test/mbt/integration/boss-history-browser.test.js',
  'test/performance/performance-page.browser.test.js','test/mbt/integration/aggregate-request-browser.test.js',
  'test/mbt/integration/boss-approval-browser.test.js','test/dispatch/frontend/operator-yard-access.browser.test.mjs',
  'test/dispatch/integration/dispatch-editor-confirmation.browser.test.js','test/mbt/integration/menu-order-browser.test.js',
  'test/audit-log/admin-audit-log-http.test.js','test/audit-log/admin-audit-log.test.js','test/audit-log/system-audit.test.js',
  'test/performance/performance.test.js']

ADMIN_LOAD_LIVE = """  if (IS_ADMIN_PAGE) {
    const [nextOperators, nextAuditOptions, nextAudit, nextSyncSettings, nextM2mStatus, nextEnvSettings, nextPhotoArchiveSettings, nextMirrorStatus, nextPublicSalesSettings, nextMapsUsage, nextAggregateAccess] = await Promise.all([
      request("/api/operators"),
      // Filter options aggregate 30 days of audit rows; they load after the page instead of delaying it.
      Promise.resolve(auditOptions),
      request(auditQueryString()).catch((error) => {
        auditLoadError = error.message;
        return [];
      }),
      request("/api/control/sync-settings"),
      request("/api/admin/netsuite-m2m"),
      request("/api/control/env-settings"),
      request("/api/admin/photo-archive"),
      request("/api/admin/netsuite-mirror"),
      request("/api/admin/public-sales"),
      request("/api/admin/maps-usage").catch((error) => ({ ...mapsUsage, error: error.message })),
      request("/api/admin/aggregate-request-access")
    ]);
    operators = nextOperators;
    aggregateAccess = nextAggregateAccess;
    auditOptions = nextAuditOptions;
    audit = nextAudit;
    auditHasMore = audit.length >= Number(auditFilters.limit || 200);
    void loadAuditOptions().then(() => {
      if (activeSection === "audit") render();
    });
    void loadAuditResources().then(() => {
      if (activeSection === "audit") render();
    });
    if (activeSection === "performance") void loadPerformance().then(() => render());
    syncSettings = nextSyncSettings;
    netsuiteM2mStatus = nextM2mStatus;
    envSettings = nextEnvSettings;
    photoArchiveSettings = nextPhotoArchiveSettings;
    mirrorStatus = nextMirrorStatus;
    publicSalesSettings = nextPublicSalesSettings;
    mapsUsage = nextMapsUsage;
    await Promise.all([
      loadAdminReturnSettings(),
      loadReturnNotificationSettings(),
      loadScmReconciliationControl()
    ]);
  } else {"""
ADMIN_LOAD_NEW = """  if (IS_ADMIN_PAGE) {
    // Only the open tab's data (2026-11-06: every tab waited ~30 s for a remembered Audit Log search).
    const keys = ADMIN_SECTION_DATA[activeSection] ?? ADMIN_SECTION_DATA.dashboard;
    await Promise.all(keys.map((key) => ADMIN_DATA_LOADERS[key]()));
  } else {"""
LOADERS = """// Admin tabs load the data they show when they are opened, not every tab's data on every page.
// The Audit Log runs no search until Apply / Refresh; the SOR auto-returns panel loads itself.
const ADMIN_SECTION_DATA = {
  dashboard: ["operators", "syncSettings", "photoArchive", "mapsUsage", "returnSettings"],
  operators: ["operators", "aggregateAccess", "publicSales"],
  sync: ["syncSettings", "m2m", "envSettings", "mirror"],
  "maps-usage": ["mapsUsage"],
  reconciliation: ["reconciliation"],
  "return-automation": ["returnSettings", "returnNotifications"],
  storage: ["photoArchive"],
  performance: ["performance"],
  audit: [],
  "sor-auto-returns": []
};
const ADMIN_DATA_LOADERS = {
  operators: async () => { operators = await request("/api/operators"); },
  aggregateAccess: async () => { aggregateAccess = await request("/api/admin/aggregate-request-access"); },
  publicSales: async () => { publicSalesSettings = await request("/api/admin/public-sales"); },
  syncSettings: async () => { syncSettings = await request("/api/control/sync-settings"); },
  m2m: async () => { netsuiteM2mStatus = await request("/api/admin/netsuite-m2m"); },
  envSettings: async () => { envSettings = await request("/api/control/env-settings"); },
  mirror: async () => { mirrorStatus = await request("/api/admin/netsuite-mirror"); },
  photoArchive: async () => { photoArchiveSettings = await request("/api/admin/photo-archive"); },
  mapsUsage: async () => {
    mapsUsage = await request("/api/admin/maps-usage").catch((error) => ({ ...mapsUsage, error: error.message }));
  },
  returnSettings: () => loadAdminReturnSettings(),
  returnNotifications: () => loadReturnNotificationSettings(),
  reconciliation: () => loadScmReconciliationControl(),
  // The report can take seconds; the tab shows "Loading…" and renders when it arrives, as before.
  performance: async () => { void loadPerformance().then(() => render()); }
};

async function loadControlData() {"""

# (file, live text, released text): each live text must occur exactly once in the live copy.
EDITS=[
  ('public/control.js', """// The From/To to return to after a click on the resources chart narrowed them.
let auditResourcesZoomFrom = null;
""", """// The From/To to return to after a click on the resources chart narrowed them.
let auditResourcesZoomFrom = null;
// The Audit Log searches only when Apply / Refresh (or a drill-down) is clicked, never on opening a page.
let auditSearched = false;
"""),
  ('public/control.js', """  if (activeSection === "count-sheets") { void controlCountSheets.load(); return; }
  if (activeSection === "damage-stock") { void controlDamage.load(); return; }
  render();
}
""", """  if (activeSection === "count-sheets") { void controlCountSheets.load(); return; }
  if (activeSection === "damage-stock") { void controlDamage.load(); return; }
  render();
  // An Admin tab loads its own data when it is opened.
  if (IS_ADMIN_PAGE && operator) void loadControlData().catch((error) => console.warn(error));
}
"""),
  ('public/control.js', 'async function loadControlData() {', LOADERS),
  ('public/control.js', ADMIN_LOAD_LIVE, ADMIN_LOAD_NEW),
  ('public/control.js', """async function loadAudit() {
  const resources = loadAuditResources();""", """async function loadAudit() {
  auditSearched = true;
  const resources = loadAuditResources();"""),
  ('public/control.js', '${t("control.latest", "Latest")} ${audit.length} ${t("control.records", "records")} · ',
   '${auditSearched ? `${t("control.latest", "Latest")} ${audit.length} ${t("control.records", "records")} · ` : ""}'),
  ('public/control.js', """      ${renderAuditResources()}
      ${renderAudit()}
""", """      ${auditSearched ? `${renderAuditResources()}${renderAudit()}` : `
        <p class="muted audit-not-loaded">${t("control.auditNotLoaded", "Choose filters and click Apply to load the Audit Log.")}</p>
      `}
"""),
  ('public/control.js', """          <strong>${audit.length}</strong>
          <em>user, NetSuite, system and error records loaded</em>""", """          <strong>${t("control.auditSearch", "Search")}</strong>
          <em>user, NetSuite, system and error records (loads on Apply)</em>"""),
  ('public/admin.html', 'sorRecords=20261103-2&auditLog=20261105-1&resources=20261105-1&perf=20261106-1"></script>',
   'sorRecords=20261103-2&auditLog=20261105-1&resources=20261105-1&perf=20261106-1&adminLazy=20261106-1"></script>'),
]
MARKERS={'public/control.js':'auditSearched','public/admin.html':'adminLazy=20261106-1'}
UNRELATED=('aiChat','ai-chat','AiChat','autoRetry','adminRepost','waiting_customer_pickup')
MAX_CHANGED_LINES=140
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
save,sha=base['save'],base['sha']
base['apply_migration']=lambda:{'migration':None}

def make_patch():
    """Capture live, apply exactly EDITS to a copy of each live file and store the resulting patch."""
    sor['capture']()
    live,staged=OUT/'live-before',OUT/'patch-stage'
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    texts={name:(live/name).read_text(encoding='utf-8') for name in FILES}
    for name,old,new in EDITS:
        assert texts[name].count(old)==1,(name,'live text not found exactly once',old[:120])
        texts[name]=texts[name].replace(old,new)
    parts=[]
    for name in FILES:
        target=staged/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(texts[name],encoding='utf-8')
        result=subprocess.run(['diff','-u','--label',f'a/server/{name}','--label',f'b/server/{name}',str(live/name),str(target)],
          capture_output=True,text=True)
        assert result.returncode==1,(name,result.stderr)
        parts.append(f'diff --git a/server/{name} b/server/{name}\n'+result.stdout)
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    CODE_PATCH.write_text(''.join(parts));PATCH.write_bytes(CODE_PATCH.read_bytes())
    check=subprocess.run(['patch','-p2','--fuzz=0','--dry-run','--batch','-d',str(live)],stdin=PATCH.open('rb'),capture_output=True,text=True)
    assert check.returncode==0,('Patch does not apply to live',check.stdout[-3000:])
    print(json.dumps({'patch':str(PATCH),'files':len(FILES),'edits':len(EDITS)}))

def prepare():
    state=sor['capture']()
    live,candidate=OUT/'live-before',OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live),str(candidate)],check=True)
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=prev['changed_files'](live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    diff,changed=[],0
    for name in FILES:
        one=subprocess.run(['git','diff','--no-index','--',str(live/name),str(candidate/name)],capture_output=True,text=True).stdout
        lines=[line for line in one.splitlines() if line[:1] in '+-' and line[:3] not in ('+++','---')]
        added=[line for line in lines if line.startswith('+')]
        assert any(MARKERS[name] in line for line in added),name
        assert not any(word in line for line in added for word in UNRELATED),f'{name}: unrelated work in candidate'
        changed+=len(lines);diff.append(one)
    assert changed<=MAX_CHANGED_LINES,('Release diff is larger than this change',changed)
    (OUT/'release.patch').write_text(''.join(diff))
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'changedLines':changed}))

def lint(art):
    """Syntax-check the changed modules and ESLint the new tests against the candidate sources."""
    tree=OUT/'candidate'
    mounts=[]
    for name in ('src','public','migrations'):mounts+=['-v',f'{tree}/{name}:/app/{name}:ro']
    checks=' && '.join([*(f'node --check {name}' for name in [*FILES,*TARGET_FILES] if name.endswith('.js')),
      'node_modules/.bin/eslint --config eslint.mbt.config.js --max-warnings=0 '+' '.join(TARGET_FILES)])
    result=subprocess.run(['docker','run','--rm','--network','none','--label','com.mbbs.lifecycle=disposable-test',
      '--cgroup-parent=mbbs-tests.slice','--init','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','--read-only',
      '--tmpfs','/tmp:size=128m',*mounts,'-v',f'{SERVER}/test:/app/test:ro','-w','/app',prev['TEST_IMAGE'],'sh','-c',checks],
      capture_output=True,text=True,timeout=600)
    (art/'lint.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,('Lint failed',(result.stdout+result.stderr)[-4000:])

def quick():
    """Target files only, live vs candidate (minutes): catches test bugs before the full validation."""
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'quick']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    extra=[name for name in os.environ.get('QUICK_EXTRA','').split() if name]
    prev.update(REGRESSION=extra)
    lint(art)
    results=prev['suite'](art)
    for label in ('live','candidate'):
        tree=results[label]
        print(label,json.dumps({f:{k:sorted(v) for k,v in tree.get(f,{}).items()} for f in [*TARGET_FILES,*extra]},indent=1))
        if any(tree.get(f,{}).get('failed') for f in [*TARGET_FILES,*extra]):
            print((art/f'{label}.log').read_text()[-6000:])

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    tests={name:sha(SERVER/name) for name in [*TARGET_FILES,*REGRESSION]}
    lint(art)
    results=prev['suite'](art)
    live,cand=results['live'],results['candidate']
    pick=lambda tree,files,kind:sorted(f'{f} :: {n}' for f in files for n in tree.get(f,{}).get(kind,()))
    checks={
      'liveTarget':{'passed':len(pick(live,TARGET_FILES,'passed')),'failed':pick(live,TARGET_FILES,'failed')},
      'candidateTarget':{'passed':len(pick(cand,TARGET_FILES,'passed')),'failed':pick(cand,TARGET_FILES,'failed')},
      'live':{'passed':len(pick(live,REGRESSION,'passed')),'failed':len(pick(live,REGRESSION,'failed'))},
      'candidate':{'passed':len(pick(cand,REGRESSION,'passed')),'failed':len(pick(cand,REGRESSION,'failed'))},
      'missingFiles':sorted(f for f in [*TARGET_FILES,*REGRESSION] if f not in cand or f not in live),
      'newFailures':sorted(set(pick(cand,REGRESSION,'failed'))-set(pick(live,REGRESSION,'failed'))),
      'liveOnlyFailures':sorted(set(pick(live,REGRESSION,'failed'))-set(pick(cand,REGRESSION,'failed'))),
      'preexistingFailures':sorted(set(pick(cand,REGRESSION,'failed'))&set(pick(live,REGRESSION,'failed'))),
      'testHashes':tests}
    save(OUT/'validation-checks.json',checks)
    ok=(checks['candidateTarget']['passed']==EXPECTED_TARGET and not checks['candidateTarget']['failed']
        and {f for f in checks['liveTarget']['failed'] if not f.endswith(' :: FILE EXIT')}==NEW_TESTS and not checks['missingFiles'] and not checks['newFailures']
        and checks['candidate']['passed']>=checks['live']['passed']>0)
    assert ok,('Validation failed',json.dumps({k:v for k,v in checks.items() if k!='testHashes'},indent=1)[-8000:])
    assert {name:sha(SERVER/name) for name in tests}==tests,'Tests changed during validation'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','liveTargetFailed':checks['liveTarget']['failed'],
      'candidateTargetPassed':checks['candidateTarget']['passed'],'live':checks['live'],'candidate':checks['candidate'],
      'liveOnlyFailures':checks['liveOnlyFailures'],'preexistingFailures':checks['preexistingFailures']}))

def build():
    # A `docker builder prune` hung since 2026-08 is ignored, as the other release tools do.
    running=subprocess.run(['pgrep','-af',r'docker(-buildx)? (buildx )?build( |$)|compose .* build( |$)'],capture_output=True,text=True).stdout.strip()
    assert not running,('Another docker build is running; overlapping builds crashed dockerd on 2026-11-03',running)
    split['build']()

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n# No migration.\n')


def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    page=subprocess.check_output(['curl','-sS','--max-time','15','http://127.0.0.1:3000/admin/sync'],text=True)
    assert 'adminLazy=20261106-1' in page,'/admin/sync does not load the new control.js'
    script=subprocess.check_output(['curl','-sS','--max-time','15','http://127.0.0.1:3000/control.js?adminLazy=20261106-1'],text=True)
    assert 'ADMIN_SECTION_DATA' in script and 'auditSearched' in script,'served control.js is not the release'
    code=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}',
      'http://127.0.0.1:3000/api/delivery/audit'],text=True))
    assert code in (401,403),f'/api/delivery/audit unauthenticated: {code}'
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'adminSyncServesRelease':True,'auditApiStatus':code})
    print(json.dumps({'liveVerification':'passed','files':len(FILES)}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'quick':quick,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
