import assert from 'node:assert/strict';
export const mutants={
 stale:['src/control-damage-domain.js',"if(input.revision!==revision)","if(false)",'domain'],
 removal:['src/control-damage-domain.js','const replace=removed.length>0;','const replace=false;','domain'],
 unknown:['src/control-damage-service.js','if(uncertain) {throw','if(false) {throw','service'],
 lock:['src/control-damage-service.js','key=`damage-month:${monthId}`','key=`wrong-control-month:${monthId}`','service'],
 units:['src/control-damage-netsuite.js',"plan.replace?'?replace=inventory':''","false?'?replace=inventory':''",'netsuite']
};
export async function load(url,context,nextLoad) {
 const result=await nextLoad(url,context),name=process.env.CONTROL_DAMAGE_MUTANT,mutation=mutants[name];
 if(!mutation || !url.endsWith('/'+mutation[0])) return result;
 const source=String(result.source);assert.equal(source.split(mutation[1]).length,2,'Mutation anchor must occur once');
 process.stderr.write(`CONTROL_DAMAGE_MUTATION_APPLIED:${name}\n`);
 return {...result,source:source.replace(mutation[1],mutation[2])};
}
