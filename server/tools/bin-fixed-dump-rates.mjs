// Operational correction authorized by the user: fixed dump prices $300/bin.
// Use versioned application commands; never rewrite an accepted tariff.
import { query } from '../src/db.js';
import { executeMbtCommand } from '../src/mbt/command-repository.js';
import { getLocalRateCardGraph, cloneLocalRateCardVersion, replaceLocalRateCardDraft,
  applyLocalRateCardDraft, validateLocalRateCardVersion, activateLocalRateCardVersion
} from '../src/mbt/rate-card-configuration-service.js';

export async function correctFixedDumpRates(input) {
  const { actor, idempotencyKey, correlationId, requestId, ...payload } = input;
  const reason = 'User requested Soil, Concrete and Asphalt at CAD 300 per bin; preserve DumpGarbage at CAD 120 per tonne.';
  const command = (step, fields) => ({ actor, reason, correlationId, requestId,
    idempotencyKey: `${idempotencyKey}:${step}`, ...fields });
  return executeMbtCommand({ actor, idempotencyKey, correlationId, requestId, payload,
    commandName: 'mbt.rate_card.fixed_dump_correction', mutation: async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext('mbt-fixed-dump-rate-correction'))");
      const soil = await getLocalRateCardGraph(input.soilVersionId);
      const concrete = await getLocalRateCardGraph(input.concreteVersionId);
      const garbage = await getLocalRateCardGraph(input.garbageVersionId);
      for (const [detail, code, amount, basis, unit] of [[soil,'SOIL',35000,'per_quantity','BIN'],
        [concrete,'CONCRETE',30000,'per_quantity','BIN'],[garbage,'DUMPGARBAGE',12000,'per_weight','TONNE']]) {
        const tariffs = detail.graph.dumpTariffs;
        if (detail.version.status !== 'active' || tariffs.length !== 1 || tariffs[0].itemCode !== code
          || tariffs[0].amountMinor !== amount || tariffs[0].pricingBasis !== basis || tariffs[0].unitOfMeasure !== unit
          || !tariffs[0].active || tariffs[0].currency !== 'CAD') throw new Error(`Rate correction precondition changed: ${code}`);
      }
      const before = {soil,concrete,garbage};
      const clone = await cloneLocalRateCardVersion(command('clone-soil', {
        sourceRateCardVersionId:input.soilVersionId, expectedRevision:soil.version.revision }));
      const soilDraft = await getLocalRateCardGraph(clone.body.version.rateCardVersionId);
      soilDraft.graph.dumpTariffs[0].amountMinor = 30000;
      soilDraft.graph.version.effectiveFrom = new Date().toISOString();
      soilDraft.graph.version.effectiveTo = null;
      const replaced = await replaceLocalRateCardDraft(command('price-soil', {sourceKind:'manual',
        rateCardVersionId:soilDraft.version.rateCardVersionId,expectedRevision:soilDraft.version.revision,graph:soilDraft.graph}));
      const validated = await validateLocalRateCardVersion(command('validate-soil', {
        rateCardVersionId:soilDraft.version.rateCardVersionId,expectedRevision:replaced.body.version.revision}));
      await activateLocalRateCardVersion(command('activate-soil', {rateCardVersionId:soilDraft.version.rateCardVersionId,
        expectedRevision:validated.body.version.revision,replacesRateCardVersionId:input.soilVersionId}));

      const asphaltGraph = structuredClone(concrete.graph);
      asphaltGraph.rateCard.rateCardCode = input.asphaltCardCode;
      asphaltGraph.rateCard.displayName = 'DumpAsphalt';
      asphaltGraph.version.versionNumber = 1;
      asphaltGraph.version.effectiveFrom = new Date().toISOString();
      asphaltGraph.version.effectiveTo = null;
      asphaltGraph.dumpTariffs = [{...asphaltGraph.dumpTariffs[0],itemCode:'ASPHALT',materialCode:'ASPHALT',
        tariffCode:'customer_asphalt',description:'Asphalt customer tariff per bin'}];
      const created = await applyLocalRateCardDraft(command('create-asphalt',{sourceKind:'manual',graph:asphaltGraph}));
      const asphalt = await validateLocalRateCardVersion(command('validate-asphalt',{
        rateCardVersionId:created.body.version.rateCardVersionId,expectedRevision:created.body.version.revision}));
      await activateLocalRateCardVersion(command('activate-asphalt',{
        rateCardVersionId:asphalt.body.version.rateCardVersionId,expectedRevision:asphalt.body.version.revision}));
      const after = {
        soil:await getLocalRateCardGraph(soilDraft.version.rateCardVersionId),
        concrete:await getLocalRateCardGraph(input.concreteVersionId),
        asphalt:await getLocalRateCardGraph(asphalt.body.version.rateCardVersionId),
        garbage:await getLocalRateCardGraph(input.garbageVersionId)
      };
      return {status:200,body:{before,after},audit:{action:'mbt.rate_card.fixed_dump_corrected',
        entityType:'mbt_rate_card_version',entityId:input.soilVersionId,beforeState:before,afterState:after,
        revisionBefore:soil.version.revision,revisionAfter:soil.version.revision+1,reason,source:'local'}};
    }});
}
