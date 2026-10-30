// User-authorized CAD500 garbage deposit per bin, separate from rental revenue.
import {query} from '../src/db.js';
import {executeMbtCommand} from '../src/mbt/command-repository.js';
import {getLocalRateCardGraph,cloneLocalRateCardVersion,replaceLocalRateCardDraft,
  validateLocalRateCardVersion,activateLocalRateCardVersion} from '../src/mbt/rate-card-configuration-service.js';

export async function configureGarbageDeposits(input) {
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  if(input.amountMinor!==50000 || !input.versionIds?.length || new Set(input.versionIds).size!==input.versionIds.length) {
    throw new Error('This correction requires CAD500 and distinct active BIN item versions.');
  }
  const reason='User requested a separate CAD500 garbage-bin deposit for every bin size; preserve rental and dumping rates.';
  const command=(step,fields)=>({actor,idempotencyKey:`${idempotencyKey}:${step}`,correlationId,requestId,reason,...fields});
  return executeMbtCommand({actor,idempotencyKey,correlationId,requestId,payload,commandName:'mbt.rate_card.garbage_deposits',mutation:async()=>{
    await query("SELECT pg_advisory_xact_lock(hashtext('mbt-garbage-deposit-configuration'))");
    const before=[],after=[];
    for(const id of input.versionIds) {
      const detail=await getLocalRateCardGraph(id);
      const itemCodes=new Set([detail.graph.rateCard.itemCode,...detail.graph.components
        .filter(component=>component.active && component.componentKind==='rental')
        .map(component=>component.itemCode)].filter(Boolean));
      const itemCode=itemCodes.size===1 ? [...itemCodes][0] : null;
      const item=(await query("SELECT item_type FROM mbt_local_item_settings WHERE item_code=$1 AND active",[itemCode])).rows[0];
      if(detail.version.status!=='active' || item?.item_type!=='bin' || detail.graph.depositRules.some(r=>r.active)) {
        throw new Error('Expected an active BIN item rate card with no configured deposit; refresh before applying.');
      }
      before.push(detail);
      const cloned=await cloneLocalRateCardVersion(command(`clone-${id}`,{sourceRateCardVersionId:id,expectedRevision:detail.version.revision}));
      const draft=await getLocalRateCardGraph(cloned.body.version.rateCardVersionId);
      draft.graph.version.effectiveFrom=new Date().toISOString();draft.graph.version.effectiveTo=null;
      draft.graph.depositRules.push({ruleCode:'garbage_bin_deposit',ruleType:'fixed',binTypeCode:null,serviceCode:'delivery',
        fixedAmountMinor:input.amountMinor,percentageBasisPoints:null,currency:'CAD',liabilityAccountMappingKey:'local_bin_deposit',
        active:true,description:'Refundable garbage-bin deposit, CAD500 per bin. Dumping charged separately after collection.'});
      const saved=await replaceLocalRateCardDraft(command(`save-${id}`,{rateCardVersionId:draft.version.rateCardVersionId,
        expectedRevision:draft.version.revision,sourceKind:'manual',graph:draft.graph}));
      const validated=await validateLocalRateCardVersion(command(`validate-${id}`,{rateCardVersionId:draft.version.rateCardVersionId,
        expectedRevision:saved.body.version.revision}));
      await activateLocalRateCardVersion(command(`activate-${id}`,{rateCardVersionId:draft.version.rateCardVersionId,
        expectedRevision:validated.body.version.revision,replacesRateCardVersionId:id}));
      after.push(await getLocalRateCardGraph(draft.version.rateCardVersionId));
    }
    return {status:200,body:{before,after},audit:{action:'mbt.rate_card.garbage_deposits_configured',entityType:'mbt_rate_card_version',
      entityId:input.versionIds[0],beforeState:{versions:before},afterState:{versions:after},
      revisionBefore:before[0].version.revision,revisionAfter:before[0].version.revision+1,reason,source:'local'}};
  }});
}
