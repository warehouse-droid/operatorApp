// @ts-check
import {AsyncLocalStorage} from 'node:async_hooks';
/** @type {AsyncLocalStorage<(phase:string)=>Promise<void>>} */
const progress = new AsyncLocalStorage();
/** @template T @param {(phase:string)=>Promise<void>} report @param {()=>Promise<T>} work */
export function withDeliveryProgress(report,work) {return progress.run(report,work);}
/** @param {string} phase */
export async function deliveryProgress(phase) {await progress.getStore()?.(phase);}
