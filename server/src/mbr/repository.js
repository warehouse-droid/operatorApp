import {createHash,randomUUID} from 'node:crypto';
import {query,withTransaction} from '../db.js';
import {MbrError,normalizeContractFields,normalizeSigningRequest,effectiveStatus,expiryDeadline} from '../../public/mbr/domain.js';
import {snapshotForFields,agreementParagraphs} from './agreement.js';
import {createLinkCredential,decryptLinkToken,hashLinkToken} from './credentials.js';
import {validateSignature} from './signature.js';
import {renderContractPdf} from './pdf.js';
import {requireAvailableEquipment} from './equipment-repository.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const iso=value=>value ? new Date(value).toISOString() : null;
const changed=()=>new MbrError('This agreement has changed. Reload and review the current version before continuing.',409,'MBR_CONTRACT_CHANGED');
function contractId(value) {
  if(typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new MbrError('Contract not found.',404,'MBR_NOT_FOUND');
  }
  return value;
}
function expectRevision(row,revision) {
  if(row.current_revision!==revision) {throw changed();}
}
function pending(row) {
  if(row.status==='expired') {throw new MbrError('This agreement expired. Ask MBR Sales for a renewed link.',410,'MBR_EXPIRED');}
  if(row.status!=='pending') {throw new MbrError('This agreement has already been completed.',409,'MBR_COMPLETED');}
}
async function event(row,kind,actorId,details={}) {
  await query('INSERT INTO mbr_contract_events(contract_id,kind,revision,actor_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',
    [row.id,kind,row.current_revision,actorId || null,JSON.stringify(details)]);
}
async function databaseTime() {return (await query('SELECT clock_timestamp() AS now')).rows[0].now;}
async function expireLocked(row,now) {
  if(effectiveStatus({status:row.status,expiresAt:row.expires_at},now)!=='expired' || row.status==='expired') {return;}
  await query("UPDATE mbr_contracts SET status='expired',updated_at=$2 WHERE id=$1",[row.id,now]);
  row.status='expired';row.updated_at=now;
  await event(row,'expired',null,{deadline:iso(row.expires_at)});
}
async function locked(id,operation) {
  const outcome=await withTransaction(async()=>{
    const row=(await query('SELECT * FROM mbr_contracts WHERE id=$1 FOR UPDATE',[contractId(id)])).rows[0];
    if(!row) {throw new MbrError('Contract not found.',404,'MBR_NOT_FOUND');}
    const now=await databaseTime();
    await expireLocked(row,now);
    // Preserve the expiration event when a command is rejected. All command
    // validation happens before its writes; unexpected/PDF failures roll back.
    try {return {value:await operation(row,now)};}
    catch(error) {if(error instanceof MbrError && error.status<500) {return {error};}throw error;}
  });
  if(outcome.error) {throw outcome.error;}
  return outcome.value;
}
async function currentSnapshot(row) {
  return (await query('SELECT snapshot FROM mbr_contract_revisions WHERE contract_id=$1 AND revision=$2',
    [row.id,row.current_revision])).rows[0].snapshot;
}
function signatureView(row) {
  const signature=row.signed_snapshot?.signature;
  return signature ? {signerName:signature.signerName,signedAt:signature.signedAt,
    protectionPlanAccepted:signature.protectionPlanAccepted,consent:signature.consent,
    imageDataUrl:'data:image/png;base64,'+row.signature_png.toString('base64')} : null;
}
function view(row,snapshot) {
  return {id:row.id,number:row.number,status:row.status,revision:row.current_revision,
    fields:snapshot.fields,issuedAt:iso(row.issued_at),expiresAt:iso(row.expires_at),
    completedAt:iso(row.completed_at),updatedAt:iso(row.updated_at),
    paragraphs:agreementParagraphs(row.signed_snapshot || snapshot),signature:signatureView(row),
    protectionPlanPercent:15};
}
async function staffView(row,snapshot) {
  const history=(await query(`SELECT e.kind,e.revision,e.details,e.created_at,o.display_name AS actor_name
    FROM mbr_contract_events e LEFT JOIN operators o ON o.id=e.actor_id
    WHERE contract_id=$1 ORDER BY e.id DESC LIMIT 100`,[row.id])).rows;
  return {...view(row,snapshot),createdBy:row.created_by,history:history.map(item=>({
    kind:item.kind,revision:item.revision,details:item.details,at:iso(item.created_at),actorName:item.actor_name || 'Customer / automatic'}))};
}
async function addRevision(row,fields,actor) {
  const snapshot=snapshotForFields(fields);
  await query('INSERT INTO mbr_contract_revisions(contract_id,revision,snapshot,created_by) VALUES($1,$2,$3::jsonb,$4)',
    [row.id,row.current_revision,JSON.stringify(snapshot),actor.id]);
  return snapshot;
}
async function tokenLink(token) {
  const link=(await query('SELECT id,contract_id,invalidated_at FROM mbr_contract_links WHERE token_hash=$1',[hashLinkToken(token)])).rows[0];
  if(!link) {throw new MbrError('This signing link is unavailable.',404,'MBR_LINK_INVALID');}
  if(link.invalidated_at) {throw new MbrError('This signing link was replaced. Ask MBR Sales for the new link.',410,'MBR_LINK_REPLACED');}
  return link;
}
function validateSearch(search,status,offset,limit) {
  if(typeof search!=='string' || search.length>200 || !['','pending','completed','expired'].includes(status)) {
    throw new MbrError('Invalid contract search or status.');
  }
  if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100) {
    throw new MbrError('Invalid contract page.');
  }
}
function activeLink(row,link) {
  if(row.active_link_id!==link.id) {throw new MbrError('This signing link was replaced. Ask MBR Sales for the new link.',410,'MBR_LINK_REPLACED');}
}

export function createMbrRepository({linkKey,baseUrl='http://localhost:3000',renderPdf=renderContractPdf}={}) {
  async function issue(row,now,fields) {
    const id=randomUUID(),credential=createLinkCredential(await linkKey(),row.id);
    await query('INSERT INTO mbr_contract_links(id,contract_id,token_hash,encrypted_token) VALUES($1,$2,$3,$4::jsonb)',
      [id,row.id,credential.hash,JSON.stringify(credential.encrypted)]);
    row.active_link_id=id;row.issued_at=now;row.expires_at=new Date(expiryDeadline(now,fields.expiryDays ?? 3));row.updated_at=now;
    await query('UPDATE mbr_contracts SET active_link_id=$2,issued_at=$3,expires_at=$4,updated_at=$3 WHERE id=$1',
      [row.id,id,now,row.expires_at]);
    return linkResult(row,credential.token);
  }
  function linkResult(row,token) {
    const url=new URL('/mbr/sign',baseUrl);url.hash=token;
    return {url:url.toString(),expiresAt:iso(row.expires_at),revision:row.current_revision};
  }
  async function create(actor,input) {
    const fields=normalizeContractFields(input);
    return withTransaction(async()=>{
      await requireAvailableEquipment(fields);
      const row=(await query(`INSERT INTO mbr_contracts(id,current_revision,created_by,updated_by)
        VALUES($1,1,$2,$2) RETURNING *`,[randomUUID(),actor.id])).rows[0];
      const snapshot=await addRevision(row,fields,actor);
      await event(row,'created',actor.id);
      return staffView(row,snapshot);
    });
  }
  async function get(id) {return locked(id,async row=>staffView(row,await currentSnapshot(row)));}
  async function list({search='',status='',offset=0,limit=50}={}) {
    validateSearch(search,status,offset,limit);
    await expireDue();
    const rows=(await query(`WITH selected AS (
      SELECT c.id,c.number,c.current_revision AS revision,c.expires_at,c.updated_at,c.completed_at,
      r.snapshot->'fields' AS fields,
      CASE WHEN c.status='pending' AND c.expires_at<=clock_timestamp() THEN 'expired' ELSE c.status END AS status
      FROM mbr_contracts c JOIN mbr_contract_revisions r ON r.contract_id=c.id AND r.revision=c.current_revision)
      SELECT * FROM selected WHERE ($1='' OR status=$1) AND ($2='' OR number ILIKE '%'||$2||'%'
      OR fields->>'lessee' ILIKE '%'||$2||'%' OR fields->>'serialNumber' ILIKE '%'||$2||'%' OR fields->>'equipmentModel' ILIKE '%'||$2||'%')
      ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,[status,search,limit+1,offset])).rows;
    return {items:rows.slice(0,limit).map(row=>({...row,expiresAt:iso(row.expires_at),updatedAt:iso(row.updated_at),
      completedAt:iso(row.completed_at)})),hasMore:rows.length>limit};
  }
  async function edit(actor,id,input) {
    const fields=normalizeContractFields(input);
    return locked(id,async(row,now)=>{
      pending(row);expectRevision(row,input.revision);
      const previous=await currentSnapshot(row),oldDeadline=iso(row.expires_at);
      await requireAvailableEquipment(fields,previous.fields);
      row.current_revision+=1;row.updated_at=now;
      if(row.issued_at) {row.expires_at=new Date(expiryDeadline(now,fields.expiryDays ?? 3));}
      const snapshot=await addRevision(row,fields,actor);
      await query('UPDATE mbr_contracts SET current_revision=$2,expires_at=$3,updated_by=$4,updated_at=$5 WHERE id=$1',
        [row.id,row.current_revision,row.expires_at,actor.id,now]);
      await event(row,'edited',actor.id,{previousDeadline:oldDeadline,deadline:iso(row.expires_at),
        changedFields:Object.keys(fields).filter(key=>fields[key]!==previous.fields[key])});
      return staffView(row,snapshot);
    });
  }
  async function link(actor,id,revision) {
    return locked(id,async(row,now)=>{
      if(row.status==='expired') {pending(row);}
      expectRevision(row,revision);
      if(row.active_link_id) {
        const record=(await query('SELECT encrypted_token FROM mbr_contract_links WHERE id=$1',[row.active_link_id])).rows[0];
        return linkResult(row,decryptLinkToken(await linkKey(),row.id,record.encrypted_token));
      }
      pending(row);
      const result=await issue(row,now,(await currentSnapshot(row)).fields);
      await event(row,'link_issued',actor.id,{deadline:iso(row.expires_at)});
      return result;
    });
  }
  async function renew(actor,id,input) {
    const fields=normalizeContractFields(input);
    return locked(id,async(row,now)=>{
      expectRevision(row,input.revision);
      if(row.status!=='expired') {throw new MbrError('Only expired agreements can be renewed.',409,'MBR_RENEWAL_INVALID');}
      await requireAvailableEquipment(fields,(await currentSnapshot(row)).fields);
      const previousDeadline=iso(row.expires_at);
      await query('UPDATE mbr_contract_links SET invalidated_at=$2 WHERE id=$1',[row.active_link_id,now]);
      row.status='pending';row.current_revision+=1;
      const snapshot=await addRevision(row,fields,actor);
      await query("UPDATE mbr_contracts SET status='pending',current_revision=$2,updated_by=$3 WHERE id=$1",[row.id,row.current_revision,actor.id]);
      const result=await issue(row,now,fields);
      await event(row,'renewed',actor.id,{previousDeadline,deadline:iso(row.expires_at)});
      return {...result,contract:await staffView(row,snapshot)};
    });
  }
  async function review(token) {
    const credential=await tokenLink(token);
    return locked(credential.contract_id,async row=>{
      activeLink(row,credential);
      if(row.status==='expired') {pending(row);}
      return view(row,await currentSnapshot(row));
    });
  }
  async function sign(token,input,metadata={}) {
    const credential=await tokenLink(token);
    const data=normalizeSigningRequest(input),signature=await validateSignature(data.signatureDataUrl);
    const submissionSha=digest(JSON.stringify({revision:data.revision,signerName:data.signerName,consent:data.consent,
      protectionPlanAccepted:data.protectionPlanAccepted,signatureSha256:signature.sha256}));
    return locked(credential.contract_id,async(row,now)=>{
      activeLink(row,credential);
      if(row.status==='completed' && row.submission_id===data.submissionId && row.submission_sha256===submissionSha) {
        return {number:row.number,status:'completed',completedAt:iso(row.completed_at)};
      }
      pending(row);expectRevision(row,data.revision);
      const snapshot={...await currentSnapshot(row),signature:{signerName:data.signerName,signedAt:iso(now),
        protectionPlanAccepted:data.protectionPlanAccepted,consent:true,
        ip:String(metadata.ip || '').slice(0,100),userAgent:String(metadata.userAgent || '').slice(0,500)}};
      snapshot.paragraphs=agreementParagraphs(snapshot);
      const bytes=await renderPdf({number:row.number,revision:row.current_revision,snapshot,signature:signature.bytes});
      await query(`UPDATE mbr_contracts SET status='completed',completed_at=$2,updated_at=$2,signed_snapshot=$3::jsonb,
        signature_png=$4,signature_sha256=$5,submission_id=$6,submission_sha256=$7,completed_pdf=$8,pdf_sha256=$9 WHERE id=$1`,
      [row.id,now,JSON.stringify(snapshot),signature.bytes,signature.sha256,data.submissionId,submissionSha,bytes,digest(bytes)]);
      await event(row,'completed',null,{signerName:data.signerName,protectionPlanAccepted:data.protectionPlanAccepted,
        signatureSha256:signature.sha256,pdfSha256:digest(bytes)});
      return {number:row.number,status:'completed',completedAt:iso(now)};
    });
  }
  async function pdf({id,token}) {
    const credential=token ? await tokenLink(token) : null;
    return locked(credential ? credential.contract_id : id,async row=>{
      if(credential) {activeLink(row,credential);}
      if(row.status==='completed') {return {bytes:row.completed_pdf,filename:`${row.number}.pdf`};}
      if(credential) {throw new MbrError('The signed PDF is available after completion.',409,'MBR_PDF_PENDING');}
      return {bytes:await renderPdf({number:row.number,revision:row.current_revision,snapshot:await currentSnapshot(row)}),
        filename:`${row.number}-unsigned.pdf`};
    });
  }
  async function expireDue() {
    return withTransaction(async()=>{
      const rows=(await query(`SELECT * FROM mbr_contracts WHERE status='pending' AND expires_at<=clock_timestamp()
        ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED`)).rows;
      for(const row of rows) {await expireLocked(row,await databaseTime());}
      return rows.length;
    });
  }
  return {create,get,list,edit,link,renew,review,sign,pdf,expireDue};
}
