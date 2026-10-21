"""Assemble the evidence report without replacing failing audit results with passes."""
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / 'test-artifacts' / HERE.name


def read(name):
    return json.loads((OUT / name).read_text())


def counts(name):
    log = (OUT / 'checks' / f'{name}.log').read_text()
    return {key: int(re.search(rf'^# {key} (\d+)$', log, re.M).group(1))
            for key in ['tests', 'pass', 'fail']}


health = read('final-health-and-source.json')
context = read('context.json')
report = {
    'outcome': 'Audit found unresolved defects; aggregate calculations do not receive an all-clear.',
    'spec': 'server/tools/aggregate-uom-audit-20261008/spec.json',
    'specApproval': 'not obtained (autonomous audit)',
    'tier': 3,
    'productionChangesDuringAudit': [],
    'summary': read('audit-summary.json'),
    'specToEvidence': {
        'all aggregate items and dates': ['collection.json', 'audit-summary.json', 'item-units.json'],
        'configured native quantity and price conversion': ['checks/core.log', 'checks/mutations.log'],
        'exact source identity': ['historical-quantity-mismatches.csv', 'legacy-line-matches.csv', 'inactive-source-lines.csv'],
        'historical execution preserved': 'No production repair was applied; 733 mismatched lines have local execution state.',
        'weight basis': ['item-units.json', 'boundaries.json', 'context.json', 'checks/defects.log'],
        'regular stock and returns': ['boundaries.json', 'checks/defects.log'],
        'aggregate whole-load calculations': ['context.json', 'checks/core.log'],
        'test cleanup and production health': ['final-health-and-source.json']
    },
    'validation': {
        'entrypoint': 'bash server/tools/aggregate-uom-audit-20261008/check.sh',
        'offlineAnalysis': 'python3 server/tools/aggregate-uom-audit-20261008/analyze.py',
        'evidenceAssembly': 'python3 server/tools/aggregate-uom-audit-20261008/evidence.py',
        'core': counts('core'),
        'knownDefects': counts('defects'),
        'manualMutation': read('checks/mutations.log'),
        'deterministicMathExamples': 1000,
        'mathSeed': 20261008,
        'aggregateRequestsChecked': len(context['aggregateRequests']),
        'aggregateRequestErrors': context['aggregateRequestErrors'],
        'node': health['runtime']['node'],
        'runtimeImage': (OUT / 'checks' / 'image.txt').read_text().strip(),
        'runtimeHashes': health['runtime']['hashes'],
        'auditToolHashes': {str(path.relative_to(HERE)): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in sorted(HERE.iterdir()) if path.is_file()},
        'liveReads': ['Full aggregate SuiteQL item/order scan', 'SOB121756 native order readers',
                      'NetSuite item 9912 REST weight 1300 kg per Yard', 'App quantity and Dispatch weight projections'],
        'liveReadLimit': 'SOA04928 REST returned HTTP 400 USER_ERROR: This record has been locked by a user defined workflow.',
        'testIsolation': 'No network; 512 MiB memory and matching swap limit; one CPU; 128 PIDs; mbbs-tests.slice; bounded tmpfs; --rm and EXIT trap; no production data or credentials in test containers.',
        'cleanup': health
    },
    'skippedLayers': {
        'fullRepositorySuite': 'Read-only audit with no application implementation change; scoped calculation tests were run.',
        'staticTypesAndLint': 'No application runtime source was changed; existing development dependency images are not installed. No clean full-project result is claimed.',
        'changedRuntimeLineCoverage': 'Not applicable: no runtime lines changed.',
        'randomizedSuiteOrder': 'Not run; deterministic cases and seed were used.',
        'propertyOnlyMutation': 'Not run; mutant rejection belongs to the whole calculation suite.',
        'databaseMutationAndConcurrency': 'Not applicable to this audit: no production repair or database-writing implementation was added.',
        'dependencyAndLicenseAudit': 'No dependencies were added or changed.',
        'inventoryStockBasis': 'Not independently verified; REST item locations returned no quantities. This remains an explicit limitation.',
        'UIBrowser': 'No browser rendering test. Verified persisted Operator/Dispatch source data and inspected deployed weight calculations.'
    },
    'documentation': [
        {'title': 'Oracle NetSuite Multiple Units of Measure',
         'url': 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N2211898.html',
         'use': 'Purchase, sales and stock units can differ; a configured base conversion is required.'},
        {'title': 'Oracle NetSuite getItemAvailability',
         'url': 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0815092044.html',
         'use': 'Read-only REST item inspection; the account returned no location quantities, which limits the inventory-basis check.'}
    ]
}
(OUT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'outcome': report['outcome'], 'core': report['validation']['core'],
                  'knownDefects': report['validation']['knownDefects'],
                  'mutantsRejected': report['validation']['manualMutation']['rejected'],
                  'testContainersRemaining': health['testContainersRemaining']}, indent=2))
