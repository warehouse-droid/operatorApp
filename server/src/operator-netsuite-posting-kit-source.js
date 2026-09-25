// @ts-check
import { fetchOperatorNetSuiteKitEvidenceFromNetSuite } from './netsuite.js';
import { normalizeOperatorKitSource } from './operator-netsuite-posting-kits.js';

/** @param {unknown} sourceId @param {{rest?: Function, queryAll?: Function}} [dependencies] */
export async function fetchOperatorKitSource(sourceId, dependencies) {
  return normalizeOperatorKitSource(await fetchOperatorNetSuiteKitEvidenceFromNetSuite(sourceId, dependencies));
}
