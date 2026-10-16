// @ts-check
/** Exclude fully received NetSuite transfers from active operator work only.
 * @param {unknown} alias
 */
export function netSuiteReceivedTransferOrderSql(alias) {
  const name=String(alias??'');
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new TypeError('A safe SQL table alias is required.');
  return `(
    UPPER(BTRIM(COALESCE(${name}.status, ''))) = 'G'
    OR UPPER(REGEXP_REPLACE(
      REGEXP_REPLACE(BTRIM(COALESCE(${name}.status_text, '')), '\\s*:\\s*', ':', 'g'),
      '\\s+', ' ', 'g'
    )) IN ('RECEIVED', 'TRANSFER ORDER:RECEIVED')
  )`;
}
