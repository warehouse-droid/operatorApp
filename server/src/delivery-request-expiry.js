/** @param {{service:{tick:()=>Promise<unknown>},logger?:Pick<Console,'error'>,intervalMs?:number}} input */
export function createDeliveryRequestExpiryRuntime({ service, logger = console, intervalMs = 60000 }) {
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;
  let running = false;
  async function tick() {
    if (running) {return;}
    running = true;
    try { await service.tick(); }
    catch (error) { logger.error('Delivery approval expiry failed:',error instanceof Error?error.message:String(error)); }
    finally { running = false; }
  }
  return {
    tick,
    start() { if (timer) {return;} timer = setInterval(() => void tick(),intervalMs); timer.unref?.(); void tick(); },
    stop() { if (timer) {clearInterval(timer);} timer = null; }
  };
}
