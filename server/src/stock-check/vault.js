import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StockCheckError } from './domain.js';

function checkedKey(key) {
  if(!Buffer.isBuffer(key) || key.length!==32) {
    throw new StockCheckError('The stock-check credential key is unavailable.',500,'STOCK_CHECK_SECRET_UNAVAILABLE');
  }
  return key;
}
function associatedData(vendorId,accountId) {
  if(!Number.isSafeInteger(vendorId) || vendorId<1 || !Number.isSafeInteger(accountId) || accountId<1) {
    throw new StockCheckError('Invalid vendor account identity.');
  }
  return Buffer.from('mbbs:stock-check:credentials:v1:'+vendorId+':'+accountId);
}
function validateSecret(secret) {
  if(typeof secret?.username!=='string' || !secret.username.trim() || secret.username.length>100 ||
    typeof secret?.password!=='string' || !secret.password || secret.password.length>2000) {
    throw new StockCheckError('Enter a login ID and password for this vendor account.',400,'STOCK_CHECK_CREDENTIALS_REQUIRED');
  }
  return {username:secret.username.trim(),password:secret.password};
}

/** @param {Buffer} key @param {{username:string,password:string}} secret @param {number} vendorId @param {number} accountId */
export function sealCredentials(key,secret,vendorId,accountId) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',checkedKey(key),iv);
  cipher.setAAD(associatedData(vendorId,accountId));
  const data=Buffer.concat([cipher.update(JSON.stringify(validateSecret(secret)),'utf8'),cipher.final()]);
  return {version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}

/** @param {Buffer} key @param {any} sealed @param {number} vendorId @param {number} accountId */
export function openCredentials(key,sealed,vendorId,accountId) {
  try {
    if(sealed?.version!==1) {throw new Error('Invalid version');}
    const decipher=crypto.createDecipheriv('aes-256-gcm',checkedKey(key),Buffer.from(sealed.iv,'base64'));
    decipher.setAAD(associatedData(vendorId,accountId));
    decipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
    const text=Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64')),decipher.final()]).toString('utf8');
    return validateSecret(JSON.parse(text));
  } catch {
    throw new StockCheckError('The saved vendor credentials could not be opened. Re-enter them in Vendor Setup.',500,'STOCK_CHECK_SECRET_UNAVAILABLE');
  }
}

function decodeKey(text) {
  const key=Buffer.from(text.trim(),'base64');
  if(key.toString('base64')!==text.trim()) {throw new Error('Invalid key');}
  return checkedKey(key);
}

/** @param {string} filename */
export async function loadCredentialKey(filename) {
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  try {return decodeKey(await fs.readFile(filename,'utf8'));}
  catch(error) {if(error.code!=='ENOENT') {throw error;}}
  const temporary=filename+'.'+crypto.randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,crypto.randomBytes(32).toString('base64')+'\n',{flag:'wx',mode:0o600});
    try {await fs.link(temporary,filename);}
    catch(error) {if(error.code!=='EEXIST') {throw error;}}
    return decodeKey(await fs.readFile(filename,'utf8'));
  } finally {await fs.unlink(temporary).catch(()=>{});}
}
