import {query} from './db.js';
import {sorSignatureRefs} from './sor-rental-policy.js';
const failure=message=>Object.assign(new Error(message),{status:400,code:'SOR_SIGNATURE_INVALID'});
export function sanitizeSorSignature(value) {
  if(value===undefined || value===null){return undefined;}
  if(typeof value!=='object' || Array.isArray(value)){throw failure('Invalid customer signature.');}
  const revision=Number(value.termsRevision);
  const signedBy=String(value.signedBy || '').trim();
  const capturedAt=String(value.capturedAt || '');
  const photoId=String(value.photoId || '').toLowerCase();
  if(!Number.isSafeInteger(revision) || revision<1 || signedBy.length>300 || !Number.isFinite(Date.parse(capturedAt))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(photoId))
    {throw failure('Invalid signature identity, time, or T&C revision.');}
  return {photoId,termsRevision:revision,signedBy,capturedAt};
}
/** @param {any} value @param {{job?: {jobId?: string, stopType?:string, orderRefs?:string[], orders?:any[]}, photos?:any[], offline?:boolean}} context */
export async function resolveSorSignature(value,{job={},photos=[],offline=false}={}) {
  const input=sanitizeSorSignature(value);
  if(!input) {
    if(photos.some(photo=>photo.recordType==='driver-customer-signature')){throw failure('Signature image has no signing details.');}
    return null;
  }
  const refs=sorSignatureRefs(job);
  if(!refs.length){throw failure('Customer signatures belong to SOR delivery dropoffs.');}
  const history=(await query('SELECT terms FROM sor_signature_terms_history WHERE revision=$1',[input.termsRevision])).rows[0];
  if(!history){throw failure('The signed T&C revision does not exist.');}
  let imageReference;
  if(offline) {
    const photo=photos.find(candidate=>candidate.photoId===input.photoId);
    if(!photo?.durableReceipt || photo.recordType!=='driver-customer-signature' || !photo.objectReference?.startsWith('r2://'))
      {throw failure('The customer signature image has not been durably received.');}
    imageReference=photo.objectReference;
  } else {
    const data=String(value.imageDataUrl || '');
    if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/u.test(data) || data.length>2800000){throw failure('A valid signature image is required.');}
    const bytes=Buffer.from(data.slice(data.indexOf(',')+1),'base64');
    if(bytes.length<4 || bytes.length>2*1024*1024 || bytes[0]!==255 || bytes[1]!==216 || bytes.at(-2)!==255 || bytes.at(-1)!==217)
      {throw failure('The signature must be a JPEG image.');}
    imageReference=data;
  }
  return {...input,imageReference,terms:history.terms,orderRefs:refs,jobId:job.jobId};
}

export async function assertSorSignaturePhotoAccess(viewer, reference) {
  if (!String(reference).includes('/driver-customer-signature/')) {return;}
  const roles = new Set([viewer?.role, ...(viewer?.roles || [])]);
  if (roles.has('admin') || roles.has('dispatcher')) {return;}
  if (viewer?.role === 'driver') {
    const owner = (await query(`SELECT 1 FROM driver_job_records WHERE lower(driver_login)=lower($1)
      AND job_details->'customerSignature'->>'imageReference'=$2 LIMIT 1`,
    [viewer.login || viewer.id, String(reference).startsWith('r2://') ? reference : `r2://${reference}`])).rowCount;
    if (owner) {return;}
  }
  throw Object.assign(new Error('This customer signature is outside your access.'), {status: 403});
}
