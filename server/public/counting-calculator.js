(function (root) {
  'use strict';
  function evaluate(expression) {
    const text=String(expression).replace(/[×xX]/g,'*').replace(/−/g,'-').replace(/\s/g,'');
    if (text.length>160 || !/^\d+(?:\.\d+)?(?:[+*-]\d+(?:\.\d+)?)*$/.test(text)) {throw new Error('Complete the calculation first.');}
    const tokens=text.match(/\d+(?:\.\d+)?|[+*-]/g);
    let total=0,term=Number(tokens[0]),sign=1;
    for(let i=1;i<tokens.length;i+=2) {
      const op=tokens[i],value=Number(tokens[i+1]);
      if(op==='*') {term*=value;}
      else {total+=sign*term;sign=op==='-'?-1:1;term=value;}
    }
    const result=Number((total+sign*term).toFixed(6));
    if(!Number.isFinite(result) || result<0 || result>1e12) {throw new Error('The result must be a finite nonnegative quantity.');}
    return result;
  }
  function press(state,key) {
    let expression=String(state?.expression || '0');
    if(key==='Clear') {return {expression:'0',value:0,evaluated:false};}
    if(key==='Back') {return {expression:expression.slice(0,-1) || '0',evaluated:false};}
    if(key==='=') {const value=evaluate(expression);return {expression:String(value),value,evaluated:true};}
    if(/^[+−×*-]$/.test(key)) {
      expression=expression.replace(/[+−×*-]$/,'')+key;
    } else if (/^[0-9.]$/.test(key)) {
      if(state?.evaluated || expression==='0') {expression=key==='.'?'0.':key;}
      else {expression+=key;}
    } else {throw new Error('Unsupported calculator key.');}
    if(expression.length>160) {throw new Error('The calculation is too long.');}
    return {expression,evaluated:false};
  }
  function pad(attribute='data-action',action='cycle-key') {
    const label=key=>key==='Clear' ? (root.MBBS_I18N?.t('common.clear','Clear') || 'Clear') : key==='Back' ? (root.MBBS_I18N?.t('common.backspace','Back') || 'Back') : key;
    const button=key=>`<button ${attribute}="${action}" data-key="${key}" type="button">${label(key)}</button>`;
    return `<div class="cycle-number-pad">${['1','2','3','4','5','6','7','8','9','Clear','0','Back'].map(button).join('')}</div><div class="count-calculator-operators">${['+','−','×','='].map(button).join('')}</div>`;
  }
  root.MBBSCountingCalculator = {evaluate,press,pad};
})(globalThis);
