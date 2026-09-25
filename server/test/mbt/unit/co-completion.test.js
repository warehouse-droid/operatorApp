import assert from 'node:assert/strict';
import test from 'node:test';
import { planJobsForDriver } from '../../../src/driver-repository.js';
import { driverPhysicalVisitExecutionJobs } from '../../../src/driver-physical-visit.js';
import { coPlan } from '../../support/co-completion-fixture.mjs';

test('a physical CO from grouped SOs retains CO identity for pickup, drop and detail scopes', () => {
  const plan = coPlan();
  const before = structuredClone(plan);
  const jobs = planJobsForDriver(plan, 'co-driver').filter(job => ['pickup', 'dropoff'].includes(job.stopType));
  assert.equal(jobs.length, 2);
  for (const job of jobs) { assert.deepEqual(job.orderRefs, ['CO-GOM-6531-6537']); assert.deepEqual(job.orderTypes, ['CO']); }
  assert.deepEqual(jobs[1].detailOrderRefs, ['CO-GOM-6531-6537']);
  assert.equal(jobs[1].jobId, '330:T4:co-load:co-drop');
  assert.equal(jobs[1].dropLocation, '2967');
  assert.deepEqual(plan, before);
});

test('CO wrappers expand only to their physical CO members', () => {
  const plan = coPlan({ groupedTransfers: true });
  const job = planJobsForDriver(plan, 'co-driver').find(candidate => candidate.stopType === 'dropoff');
  assert.deepEqual(job.orderRefs, ['CO-SOM06531', 'CO-SOM06537']);
  assert.deepEqual(job.detailOrderRefs, job.orderRefs);
});

test('CO and TO at one physical visit keep separate durable execution references', () => {
  const jobs = planJobsForDriver(coPlan({ extraTransfer: true }), 'co-driver');
  const drop = jobs.find(candidate => candidate.stopId === 'co-drop');
  assert.deepEqual(drop.detailOrderRefs, ['CO-GOM-6531-6537', 'TOB01106']);
  const execution = driverPhysicalVisitExecutionJobs(drop, jobs);
  assert.deepEqual(execution.map(job => job.orderRefs), [['CO-GOM-6531-6537'], ['TOB01106']]);
  assert.deepEqual(execution.map(job => job.stopId), ['co-drop', 'to-drop']);
});
