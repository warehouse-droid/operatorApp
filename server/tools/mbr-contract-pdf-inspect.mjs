import fs from 'node:fs';
import {pdfText} from '../test/field-sales/pdf-text.js';
const template=JSON.parse(fs.readFileSync('src/mbr/agreement-template.json'));
const pdf=fs.readFileSync('test-artifacts/mbr-contract/browser/chromium-signed-contract.pdf');
const compact=value=>value.replace(/\s+/gu,'');
const wanted=compact(template.paragraphs[10]),actual=compact(pdfText(pdf));
const start=actual.indexOf(wanted.slice(0,80));
let matched=0;
while(actual[start+matched]===wanted[matched] && matched<wanted.length) {matched+=1;}
console.log(JSON.stringify({firstMismatch:matched,expected:wanted.slice(Math.max(0,matched-50),matched+90),
  actual:actual.slice(start+Math.max(0,matched-50),start+matched+180)}));
console.log('Present after removing only page footer:',actual.replace(/MBR-\d{4}-\d+·Revision\d+·\d+\/\d+/gu,'').includes(wanted));
