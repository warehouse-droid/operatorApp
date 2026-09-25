import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { fail,required,uuid } from '../../public/field-sales/domain.js';

export async function saveQuoteEvidence(db,actor,quoteId,p) {
 const id=uuid(p.id),qid=uuid(quoteId),encoded=String(p.base64||'');
 if(!encoded||encoded.length>11200000||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)){throw fail('Choose a PDF or image smaller than 8 MB.');}
 const raw=Buffer.from(encoded,'base64');if(raw.length>8388608){throw fail('Confirmation evidence must be smaller than 8 MB.');}
 const hash=createHash('sha256').update(raw).digest('hex');let content=raw,contentType='application/pdf';
 if(raw.subarray(0,5).toString()!=='%PDF-'){
  try{content=await sharp(raw,{limitInputPixels:50000000}).rotate().resize(2400,2400,{fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();contentType='image/jpeg';}
  catch{throw fail('Choose a readable PDF, JPEG, PNG, or WebP file.');}
 }
 return db.transaction(async()=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`quote-evidence:${id}`]);
  const old=(await db.query('SELECT * FROM field_sales_quote_evidence WHERE id=$1',[id])).rows[0];
  if(old){if(old.quote_id!==qid||old.revision!==Number(p.revision)||old.actor_id!==String(actor.id)||old.sha256!==hash){throw fail('This evidence ID already contains different work.',409);}return {id};}
  const quote=(await db.query('SELECT * FROM field_sales_quotes WHERE id=$1 FOR UPDATE',[qid])).rows[0];
  if(!quote){throw fail('Quote not found.',404);}if(quote.parent_quote_id){throw fail('Attach evidence to the combined parent quote.',409);}
  if(quote.confirmation||quote.revision!==Number(p.revision)){throw fail('Attach evidence to the current unconfirmed quote revision.',409);}
  const count=(await db.query('SELECT count(*)::int AS n FROM field_sales_quote_evidence WHERE quote_id=$1 AND revision=$2',[qid,quote.revision])).rows[0].n;
  if(count>=10){throw fail('A quote revision supports up to 10 confirmation files.');}
  await db.query('INSERT INTO field_sales_quote_evidence(id,quote_id,revision,actor_id,name,content_type,content,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,qid,quote.revision,actor.id,required(p.name,'Filename',250),contentType,content,hash]);return {id};
 });
}
