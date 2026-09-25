export const added = [
  'migrations/220_operator_inventory_workflows.sql',
  'src/inventory-workflow-domain.js','src/count-sheet-repository.js','src/inventory-damage-repository.js',
  'src/inventory-damage-service.js','src/inventory-damage-netsuite.js','src/operator-inventory-router.js',
  'public/counting-calculator.js','public/operator-inventory.js','public/operator-inventory.css',
  'public/control-count-sheets.js','public/control-count-sheets.css'
];
export const existing = ['src/server.js','src/netsuite.js','src/photo-upload.js','src/photo-archive-repository.js',
  'src/operator-yard-authorization.js','public/operator.js','public/operator.html','public/control.js',
  'public/control.html','public/admin.html','public/app-sidebar.js','public/i18n.js','public/service-worker.js'];
export const production = [...added,...existing];
export const tests = ['domain','adapter','photos','count','damage','http','browser'].map(name=>`test/operator-inventory-${name}.test.js`);
