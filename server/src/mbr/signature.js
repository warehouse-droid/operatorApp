import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {MbrError} from '../../public/mbr/domain.js';

function encodedSignature(value) {
  if(typeof value!=='string' || value.length>700000) {throw new MbrError('Signature image is too large.',413);}
  if(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)) {throw new MbrError('Draw a valid signature.');}
  const encoded=value.slice(value.indexOf(',')+1),bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded || bytes.length>512*1024) {throw new MbrError('Invalid signature image.');}
  return bytes;
}

function hasInk(data,channels) {
  let ink=0;
  for(let index=0;index<data.length;index+=channels) {
    if(data[index+3]>20 && Math.min(data[index],data[index+1],data[index+2])<200) {ink+=1;}
    if(ink>=20) {return true;}
  }
  return false;
}

export async function validateSignature(value) {
  const original=encodedSignature(value);
  try {
    const decoder=sharp(original,{limitInputPixels:1000000});
    const metadata=await decoder.metadata();
    if(metadata.format!=='png' || metadata.width<64 || metadata.height<32
        || metadata.width>1600 || metadata.height>800 || (metadata.pages || 1)!==1) {
      throw new MbrError('Draw a valid signature in the signature area.');
    }
    const raw=await decoder.clone().ensureAlpha().raw().toBuffer({resolveWithObject:true});
    if(!hasInk(raw.data,raw.info.channels)) {throw new MbrError('Please draw your signature before signing.');}
    const bytes=await decoder.flatten({background:'white'}).resize(900,320,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
    return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  } catch(error) {
    if(error instanceof MbrError) {throw error;}
    throw new MbrError('This signature image could not be read. Please draw it again.');
  }
}
