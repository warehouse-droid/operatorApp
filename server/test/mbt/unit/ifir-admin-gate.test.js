import assert from 'node:assert/strict';
import test from 'node:test';
import { IFIR_POSTING_FLAG_KEY, isIfirPostingDeploymentReady, getIfirPostingRestletEnabled } from '../../../src/netsuite-ifir-posting-policy.js';
import { createIfirPostingClient } from '../../../src/netsuite-ifir-posting-client.js';
import { materializeMbtAdminGates, MBT_ADMIN_WRITABLE_GATE_KEYS } from '../../../src/mbt/feature-gate-catalog.js';

const settings = { ifirPostingEnabled: true, directAccessEnabled: true,
  ifirPostingRestletUrl: 'https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1' };
const step = {sourceOrderKind:'SO',transactionType:'IF',sourceNetSuiteId:42,
  payload:{externalId:'test-only',item:{items:[{orderLine:1,quantity:1,itemReceive:true,location:1}]}}};

test('Admin gate is visible, writable, independent, and defaults off', () => {
  assert.ok(MBT_ADMIN_WRITABLE_GATE_KEYS.includes(IFIR_POSTING_FLAG_KEY));
  const [gate] = materializeMbtAdminGates({flags:[{flagKey:IFIR_POSTING_FLAG_KEY,enabled:false,revision:1}],
    environment:{ifirPostingReady:true}}).filter(g=>g.flagKey===IFIR_POSTING_FLAG_KEY);
  assert.equal(gate.label,'IR/IF posting via RESTlet');
  assert.equal(gate.locked,false); assert.equal(gate.effective,false); assert.equal(gate.independent,true);
  assert.equal(gate.deploymentGuarded,false,'The RESTlet toggle must not require Dispatch read-model readiness');
});

test('property: every deployment/database gate combination agrees with Admin effective state', async () => {
  for (const enabled of [false,true]) for (const direct of [false,true])
    for (const url of ['',settings.ifirPostingRestletUrl]) for (const row of [undefined,{enabled:false},{enabled:true},{enabled:'true'}]) {
      const configured={ifirPostingEnabled:enabled,directAccessEnabled:direct,ifirPostingRestletUrl:url};
      let reads=0;
      const queryFn=async(sql,values)=>{ reads++; assert.match(sql,/^SELECT enabled FROM mbt_feature_flags/);
        assert.deepEqual(values,[IFIR_POSTING_FLAG_KEY]);return {rows:row?[row]:[]};};
      const ready=enabled && direct && Boolean(url);
      const expected=ready && row?.enabled===true;
      assert.equal(isIfirPostingDeploymentReady(configured),ready);
      assert.equal(await getIfirPostingRestletEnabled({settings:configured,queryFn}),expected);
      assert.equal(reads,ready?1:0);
      const gate=materializeMbtAdminGates({flags:row?[{flagKey:IFIR_POSTING_FLAG_KEY,...row,revision:1}]:[],
        environment:{enabled:false,ifirPostingReady:ready}}).find(g=>g.flagKey===IFIR_POSTING_FLAG_KEY);
      assert.equal(gate.effective,expected);assert.equal(gate.locked,!row);
    }
});

test('posting observes on/off/on on consecutive attempts without restart', async () => {
  let enabled=true,reads=0,posts=0;
  const post=createIfirPostingClient({
    settings:async()=>({enabled:await getIfirPostingRestletEnabled({settings,queryFn:async()=>{reads++;return {rows:[{enabled}]};}}),
      url:settings.ifirPostingRestletUrl,accountId:'6518947'}),
    getToken:async()=> 'test-only',mutate:fn=>fn(),request:async()=>{posts++;throw new Error('simulated uncertain response');}
  });
  await assert.rejects(post(step),/simulated uncertain response/);assert.equal(posts,1);
  enabled=false;assert.equal(await post(step),null);assert.equal(posts,1);
  enabled=true;await assert.rejects(post(step),/simulated uncertain response/);assert.equal(posts,2);assert.equal(reads,3);
});

test('database failure stops the client before credentials or any NetSuite POST', async () => {
  const post=createIfirPostingClient({
    settings:async()=>({enabled:await getIfirPostingRestletEnabled({settings,queryFn:async()=>{throw new Error('database unavailable');}})}),
    getToken:async()=>assert.fail('credentials must not be read'),mutate:()=>assert.fail('mutation must not run'),request:()=>assert.fail('HTTP must not run')
  });
  await assert.rejects(post(step),/database unavailable/);
});
