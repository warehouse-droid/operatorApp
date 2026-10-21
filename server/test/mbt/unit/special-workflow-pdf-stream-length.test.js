import assert from 'node:assert/strict';
import test from 'node:test';
import {deflateSync} from 'node:zlib';
import {pdfText} from '../../field-sales/pdf-text.js';

test('PDF test reader preserves a compressed checksum ending in carriage return',()=>{
 let compressed;
 for(let n=0;n<256;n++){
  compressed=deflateSync(Buffer.from('BT /F1 12 Tf [<4849>] TJ ET %'+'a'.repeat(n)));
  if(compressed.at(-1)===13)break;
 }
 assert.equal(compressed.at(-1),13);
 const pdf=Buffer.concat([Buffer.from(`1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),compressed,Buffer.from('\nendstream\nendobj\n')]);
 assert.equal(pdfText(pdf),'HI');
});
