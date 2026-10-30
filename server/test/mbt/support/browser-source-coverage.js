/** Chromium can omit source for scripts present at a later coverage checkpoint.
 * Capture the same static asset from the running application for offset mapping.
 * The coverage report compares it byte-for-byte with the validated source tree.
 */
export async function withBrowserCoverageSources(page,entries) {
  const sources=new Map();
  for(const entry of entries) {
    if (entry.source!==undefined || !entry.url.startsWith("http")) continue;
    if (!sources.has(entry.url)) {
      const response=await page.request.get(entry.url);
      if (!response.ok()) throw new Error(`Cannot read covered browser asset: ${entry.url}`);
      sources.set(entry.url,await response.text());
    }
    entry.source=sources.get(entry.url);
  }
  return entries;
}
