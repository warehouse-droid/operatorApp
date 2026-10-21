import {parse} from 'espree';

// JSDoc assertions do not execute. Identify statements that are structurally
// identical to the baseline, rather than adding tests just to exercise casts.
export function annotationOnlyLines(before,after){
  const statements=source=>{
    const found=[];
    const visit=node=>{if(!node||typeof node!=='object')return;
      if(node.type?.endsWith('Statement')||node.type==='VariableDeclaration')found.push(node);
      for(const [key,value] of Object.entries(node)){if(['loc','range','start','end'].includes(key))continue;if(Array.isArray(value))value.forEach(visit);else visit(value);}
    };
    visit(parse(source,{ecmaVersion:'latest',sourceType:'module',loc:true,range:true}));return found;
  };
  const identity=node=>JSON.stringify(node,(key,value)=>['loc','range','start','end'].includes(key)?undefined:typeof value==='bigint'?{bigintLiteral:String(value)}:value);
  const original=new Set(statements(before).map(identity)),lines=new Set();
  for(const node of statements(after)){
    if(!/\/\*\*\s*@type\b/u.test(after.slice(...node.range))||!original.has(identity(node)))continue;
    for(let line=node.loc.start.line;line<=node.loc.end.line;line++)lines.add(line);
  }
  return lines;
}
