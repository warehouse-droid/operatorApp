// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { createDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import {
  syncDispatchPlanOrderAssignments,
  syncDispatchPlanRelationEdges
} from "../../../src/dispatch-planner-v2-repository.js";
import { app } from "../../../src/server.js";

const PASSWORD = "test-dispatch-v2-isolated-password";

/**
 * A deliberately small, fully materialized order record.  It is a test fixture,
 * not a NetSuite mirror row: command tests must never contact external systems.
 *
 * @param {string} ref
 * @param {number} index
 */
export function dispatchOrder(ref, index) {
  return {
    id: ref,
    orderId: ref,
    refNumber: ref,
    type: "SO",
    status: "Pending Fulfillment",
    customer: `Dispatch V2 Customer ${index}`,
    pickupLocation: "3445",
    dropoffLocation: `${100 + index} Isolated Test Road`,
    items: [{ itemName: `ITEM-${index}`, quantity: 1, uom: "EA" }],
    totalWeightLbs: 1000 + index,
    testOnly: true
  };
}

/** @param {string[]} refs */
export function dispatchTrucks(refs) {
  return [{
    plate: "DP-V2-TEST",
    id: "DP-V2-TEST",
    loads: [{
      id: "dp-v2-load-1",
      name: "Load 1",
      stops: refs.map((ref, index) => ({
        id: `dp-v2-stop-${index + 1}`,
        type: "delivery",
        orderRefs: [ref],
        location: `${100 + index} Isolated Test Road`
      }))
    }]
  }];
}

/** @param {unknown} payload */
export function responseBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
}

/**
 * Create a per-file isolated HTTP fixture. The normal test runner clones the
 * disposable mbt_test database before this module executes.
 */
export async function createDispatchV2Fixture({ role = "dispatcher" } = {}) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const username = `dispatch-v2-${role}-${suffix.slice(0, 14)}`;
  const operator = await createOperator({
    username,
    displayName: `Dispatch V2 ${role} Isolated Tester`,
    password: PASSWORD,
    role
  });
  const session = await loginOperator(username, PASSWORD);
  let server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /**
   * @param {string} path
   * @param {{method?: string, body?: unknown, token?: string, headers?: Record<string, string>}} [options]
   */
  async function request(path, { method = "GET", body, token = session.token, headers = {} } = {}) {
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    return {
      response,
      payload,
      durationMs: performance.now() - startedAt,
      responseBytes: Buffer.byteLength(text, "utf8")
    };
  }

  /**
   * Seed only a Dispatch plan snapshot inside the disposable test database.
   * This bypasses unrelated legacy save side effects, then materializes the
   * assignment/relation read projections that are part of a normal persisted
   * snapshot transaction.
   *
   * @param {{date: string, refs: string[]}} input
   */
  async function seedPlan({ date, refs }) {
    const plan = await createDispatchPlan({ planDate: date, note: "isolated dispatch v2 fixture" });
    const orders = refs.map(dispatchOrder);
    const trucks = dispatchTrucks(refs);
    const summary = { testOnly: true };
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb, trucks = $3::jsonb, summary = $4::jsonb, saved_at = now()
        WHERE plan_id = $1`,
      [plan.id, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify(summary)]
    );
    const projectedPlan = { ...plan, orders, trucks, summary };
    await syncDispatchPlanOrderAssignments(projectedPlan);
    await syncDispatchPlanRelationEdges(projectedPlan);
    return {
      ...(await query("SELECT id::text AS id, revision::int AS revision, plan_date::text AS plan_date FROM dispatch_plans WHERE id = $1", [plan.id])).rows[0],
      refs
    };
  }

  /** @param {{planDate: string, sessionId: string}} input */
  async function acquireLease({ planDate, sessionId }) {
    const result = await request("/api/dispatch/plan-edit-lease/acquire", {
      method: "POST",
      body: { planDate, sessionId }
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.ok(result.payload.editLeaseToken, "The v2 command fixture needs a normal dispatcher edit lease.");
    return result.payload.editLeaseToken;
  }

  async function close() {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    await query("DELETE FROM operators WHERE id = $1", [operator.id]).catch(() => undefined);
    await closeDb();
  }

  return { request, seedPlan, acquireLease, close, operator, session, username };
}
