import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {MbrError} from '../../public/mbr/domain.js';

function decodeKey(text) {
  const key=Buffer.from(text.trim(),'base64');
  if(key.length!==32 || key.toString('base64')!==text.trim()) {throw new Error('The MBR signing link key is invalid.');}
  return key;
}

export async function loadLinkKey(filename) {
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  try {return decodeKey(await fs.readFile(filename,'utf8'));}
  catch(error) {if(error.code!=='ENOENT') {throw error;}}
  const generated=crypto.randomBytes(32);
  try {await fs.writeFile(filename,generated.toString('base64')+'\n',{flag:'wx',mode:0o600});return generated;}
  catch(error) {if(error.code!=='EEXIST') {throw error;}}
  return decodeKey(await fs.readFile(filename,'utf8'));
}

export function hashLinkToken(token) {
  if(typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new MbrError('This signing link is unavailable.',404,'MBR_LINK_INVALID');
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createLinkCredential(key,contractId) {
  const token=crypto.randomBytes(32).toString('base64url'),iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`mbr:contract-link:v1:${contractId}`));
  const data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return {token,hash:hashLinkToken(token),encrypted:{version:1,iv:iv.toString('base64'),
    tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}};
}

export function decryptLinkToken(key,contractId,encrypted) {
  if(encrypted?.version!==1) {throw new Error('Unsupported MBR signing link key record.');}
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(encrypted.iv,'base64'));
  decipher.setAAD(Buffer.from(`mbr:contract-link:v1:${contractId}`));
  decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
  const token=Buffer.concat([decipher.update(Buffer.from(encrypted.data,'base64')),decipher.final()]).toString('utf8');
  hashLinkToken(token);
  return token;
}
