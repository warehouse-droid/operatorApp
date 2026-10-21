import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {loadLinkKey,createLinkCredential,decryptLinkToken,hashLinkToken} from '../../src/mbr/credentials.js';
import {validateSignature} from '../../src/mbr/signature.js';

export async function signatureImage() {
  const svg = '<svg width="900" height="320"><rect width="900" height="320" fill="white"/><path d="M40 180 Q90 30 120 190 Q160 50 190 170 L280 120 L250 200 L360 150" fill="none" stroke="black" stroke-width="5"/></svg>';
  return 'data:image/png;base64,' + (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
}

test('link credentials are random, hash-validated and encrypted for their own contract', () => {
  const key = Buffer.alloc(32, 7), a = createLinkCredential(key, 'contract-a'), b = createLinkCredential(key, 'contract-a');
  assert.match(a.token,/^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(a.token,b.token);
  assert.equal(hashLinkToken(a.token), a.hash);
  assert.equal(decryptLinkToken(key,'contract-a',a.encrypted),a.token);
  assert.ok(!JSON.stringify(a.encrypted).includes(a.token));
  assert.throws(() => decryptLinkToken(key,'contract-b',a.encrypted));
  assert.throws(() => decryptLinkToken(Buffer.alloc(32,8),'contract-a',a.encrypted));
  assert.throws(() => hashLinkToken('short'), {status:404});
});

test('persistent link key survives reload, is private, and corrupt keys fail closed', async t => {
  let directory=null;
  t.after(async()=>{if(directory){await rm(directory,{recursive:true,force:true});}});
  directory = await mkdtemp(path.join(os.tmpdir(),'mbr-key-'));
  const filename = path.join(directory,'.mbr-signing-link-key');
  const key = await loadLinkKey(filename);
  assert.equal(key.length,32);
  assert.deepEqual(await loadLinkKey(filename),key);
  assert.equal((await stat(filename)).mode & 0o777,0o600);
  assert.equal(Buffer.from((await readFile(filename,'utf8')).trim(),'base64').length,32);
  await writeFile(filename,'bad');
  await assert.rejects(loadLinkKey(filename),/key/i);
});

test('signature accepts actual PNG ink and rejects blank, malformed, SVG and oversized images', async () => {
  const accepted = await validateSignature(await signatureImage());
  assert.ok(accepted.bytes.length > 100);
  assert.match(accepted.sha256,/^[0-9a-f]{64}$/u);
  const white = await sharp({create:{width:900,height:320,channels:3,background:'white'}}).png().toBuffer();
  const large = await sharp({create:{width:1800,height:900,channels:3,background:'black'}}).png().toBuffer();
  for (const input of ['', 'data:image/svg+xml;base64,abc', 'data:image/png;base64,abc',
    'data:image/png;base64,'+Buffer.from('not a PNG image').toString('base64'),
    'data:image/png;base64,'+white.toString('base64'), 'data:image/png;base64,'+large.toString('base64'),
    'data:image/png;base64,'+'A'.repeat(800000)]) {
    await assert.rejects(validateSignature(input), error=>error.status===400 || error.status===413);
  }
});

test('concurrent first-use key loaders all receive one durable encryption key',async t=>{
  let directory=null;t.after(async()=>{if(directory){await rm(directory,{recursive:true,force:true});}});
  directory=await mkdtemp(path.join(os.tmpdir(),'mbr-key-race-'));
  const filename=path.join(directory,'.mbr-signing-link-key');
  const keys=await Promise.all(Array.from({length:20},()=>loadLinkKey(filename)));
  for(const key of keys) {assert.deepEqual(key,keys[0]);}
  assert.deepEqual(await loadLinkKey(filename),keys[0]);
});
