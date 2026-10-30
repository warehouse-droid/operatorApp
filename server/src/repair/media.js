import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {validateDeliveryInstructionImageBytes} from '../delivery-instruction-media-validation.js';
import {createPhotoUploadToken,createPhotoReadToken,photoUploadSettings} from '../photo-upload.js';
import {fail,uuid} from '../../public/repair/domain.js';
import {hash} from './repository.js';
import {readArchivedPhoto} from '../photo-archive-repository.js';
export async function validateRepairMedia(bytes,mimeType,kind){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>10485760)throw fail('File must be between 1 byte and 10 MB.',413);
 if(mimeType==='application/pdf'){
  if(kind!=='receipt')throw fail('A photo image is required for this attachment.');
  if(!bytes.subarray(0,8).toString().startsWith('%PDF-')||!bytes.subarray(-2048).toString().includes('%%EOF'))throw fail('The PDF receipt is incomplete or invalid.');
 }else {try{await validateDeliveryInstructionImageBytes(bytes,{mimeType,declaredByteSize:bytes.length});}catch(error){throw fail(`Invalid image: ${error.message}`,error.status||422);}}
 return {bytes,mimeType,byteSize:bytes.length,sha256:hash(bytes)};
}
export function createRepairMedia({repo,dataDir,fetchImpl=fetch}){
 const directory=path.join(dataDir,'repair-originals');
 async function upload(actor,input,bytes){
  if(Boolean(input.requestId)===Boolean(input.purchaseId))throw fail('Choose exactly one repair or purchase for this attachment.');
  await repo.authorizeEvidence(actor,input);
  if(!['defect','work','handover','receipt','purchase_photo','part_request'].includes(input.kind)||Boolean(input.purchaseId)!==['receipt','purchase_photo'].includes(input.kind))throw fail('Invalid attachment type.');
  const media=await validateRepairMedia(bytes,input.mimeType,input.kind),id=randomUUID();let storageKey;
  if(photoUploadSettings().provider==='r2_worker'){
   const ticket=createPhotoUploadToken({actor,source:'repair',recordType:'repair-evidence',metadata:{jobId:input.requestId||input.purchaseId,photoId:id,sha256:media.sha256,byteSize:bytes.length,mimeType:input.mimeType},options:{maxBytes:10485760,allowedTypes:[input.mimeType]}});
   const body=new FormData();body.append('file',new Blob([bytes],{type:input.mimeType}),input.filename);
   const response=await fetchImpl(ticket.uploadUrl,{method:'POST',headers:{Authorization:`Bearer ${ticket.token}`},body,signal:AbortSignal.timeout(60000)});if(!response.ok)throw fail('Evidence upload failed. Please retry.',502);
   const result=await response.json();const key=String(result.key||result.objectKey||result.r2Key||result.reference||result.photoRef||'').replace(/^r2:\/\//u,'');
   if(!key.startsWith(ticket.metadata.keyPrefix+'/'))throw fail('Evidence upload could not be verified.',502);storageKey=`r2://${key}`;
  }else{await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(path.join(directory,id),bytes,{flag:'wx',mode:0o600});storageKey=`repair-local:${id}`;}
  try{return await repo.addAttachment(actor,{...input,id,storageKey,byteSize:media.byteSize,sha256:media.sha256});}
  catch(error){if(storageKey.startsWith('repair-local:'))await fs.unlink(path.join(directory,id)).catch(()=>{});throw error;}
 }
 async function read(actor,id){const attachment=await repo.attachment(actor,id);let bytes;
  if(attachment.storage_key.startsWith('repair-local:'))bytes=await fs.readFile(path.join(directory,uuid(attachment.storage_key.slice(13))));
  else {const archived=await readArchivedPhoto(attachment.storage_key);if(archived?.available)bytes=archived.bytes;
   else {const ticket=createPhotoReadToken({actor,key:attachment.storage_key});const response=await fetchImpl(ticket.objectUrl,{headers:{Authorization:`Bearer ${ticket.token}`},signal:AbortSignal.timeout(30000)});if(!response.ok)throw fail('Attachment is temporarily unavailable.',502);
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>10485760)throw fail('Stored attachment exceeds its expected size.',502);chunks.push(chunk);}bytes=Buffer.concat(chunks);
   }
  }
  if(bytes.length!==attachment.byte_size||hash(bytes)!==attachment.sha256)throw fail('Attachment integrity check failed.',502);return {attachment,bytes};
 }
 return {upload,read};
}
