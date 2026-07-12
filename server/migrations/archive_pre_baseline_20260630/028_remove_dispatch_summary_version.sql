UPDATE dispatch_plan_snapshots
   SET summary = summary - 'version'
 WHERE summary ? 'version';
