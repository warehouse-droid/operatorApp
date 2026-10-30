import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2),label=args.join(' ').replace(/[^a-z0-9]+/gi,'-').slice(-90);
const child=spawn(args[0],args.slice(1),{stdio:['inherit','pipe','pipe']});let output='',pending='';
child.stdout.on('data',value=>{
  output+=value;pending+=value;const lines=pending.split('\n');pending=lines.pop();
  for(const line of lines) if(line.startsWith('[isolation]')) console.log(line);
});child.stderr.on('data',value=>{output+=value;});
child.on('error',error=>{throw error;});
const code=await new Promise(resolve=>child.on('close',(status,signal)=>resolve(signal?1:(status ?? 1))));
writeFileSync(`test-artifacts/${label}.log`,output);
const sums={tests:0,pass:0,fail:0,cancelled:0,skipped:0};
for (const line of output.split('\n')) {
  const match=line.match(/^ℹ (tests|pass|fail|cancelled|skipped) (\d+)/u);if (match) sums[match[1]]+=Number(match[2]);
  if (line.startsWith('Isolated ')) console.log(line);
}
if (code) for(const section of output.split(/(?=\[isolation\])/u)) {
  const at=section.indexOf('✖ failing tests:');if(at>=0) console.log(section.slice(at).split('\n').filter(line=>!line.includes('matcherResult:')).join('\n'));
}
console.log(JSON.stringify({command:args,exitCode:code,...sums}));
process.exitCode=code || 0;
