// Bound test-process lifetime without changing tests or application code.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/test/support/test-database-isolation.mjs')) {return result;}
  const source = String(result.source);
  const anchor = 'env: environment,\n      stdio: ["inherit", "pipe", "inherit"]';
  if (source.split(anchor).length !== 2) {throw new Error('The test timeout hook no longer matches its boundary');}
  return { ...result, source: source.replace(anchor,
    'env: environment,\n      timeout: 90000,\n      stdio: ["inherit", "pipe", "inherit"]') };
}
