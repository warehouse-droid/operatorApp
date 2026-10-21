import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sealCredentials,openCredentials,loadCredentialKey } from '../../../src/stock-check/vault.js';

test('vendor credentials are encrypted and round-trip only in the selected account context',()=>{
  const key=crypto.randomBytes(32),secret={username:'fixture-user',password:'fixture-password'};
  const sealed=sealCredentials(key,secret,1,5);
  assert.equal(JSON.stringify(sealed).includes(secret.password),false);
  assert.deepEqual(openCredentials(key,sealed,1,5),secret);
  assert.throws(()=>openCredentials(key,sealed,2,5)); assert.throws(()=>openCredentials(key,sealed,1,6));
});
test('encryption uses distinct nonces and rejects changed ciphertext, tags, versions and keys',()=>{
  const key=crypto.randomBytes(32),secret={username:'fixture-user',password:'fixture-password'};
  const a=sealCredentials(key,secret,1,5),b=sealCredentials(key,secret,1,5);
  assert.notEqual(a.iv,b.iv);
  for(const changed of [{...a,version:7},{...a,tag:Buffer.alloc(16).toString('base64')},{...a,data:Buffer.alloc(12).toString('base64')}]) {
    assert.throws(()=>openCredentials(key,changed,1,5));
  }
  assert.throws(()=>openCredentials(crypto.randomBytes(32),a,1,5));
  assert.throws(()=>sealCredentials(Buffer.alloc(12),secret,1,5));
});
test('concurrent key initialization is atomic and creates a private stable key',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-key-'));
  try {
    const filename=path.join(directory,'.key');
    const keys=await Promise.all(Array.from({length:10},()=>loadCredentialKey(filename)));
    for(const key of keys) {assert.equal(key.length,32); assert.deepEqual(key,keys[0]);}
    assert.equal((await fs.stat(filename)).mode&0o777,0o600);
    await fs.writeFile(filename,'malformed'); await assert.rejects(loadCredentialKey(filename));
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
