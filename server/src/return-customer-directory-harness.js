import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  getLocalReturnCustomerById,
  normalizeReturnCustomerDirectoryEntry,
  searchLocalReturnCustomerDirectory,
  syncReturnCustomerDirectory,
  upsertReturnCustomerDirectoryEntries,
  validateReturnCustomerDirectorySnapshot
} from "./return-customer-directory.js";

const [migration, directorySource, netSuiteSource, repositorySource, serverSource] = await Promise.all([
  fs.readFile(new URL("../migrations/073_return_customer_directory.sql", import.meta.url), "utf8"),
  fs.readFile(new URL("./return-customer-directory.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./return-netsuite.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./return-repository.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./server.js", import.meta.url), "utf8")
]);

function pureTests() {
  assert.deepEqual(
    normalizeReturnCustomerDirectoryEntry({
      id: "7988",
      entityId: " C-7988 ",
      companyName: " Alpha   Stone Inc. ",
      phone: "(416) 555-0101"
    }),
    {
      id: 7988,
      internalId: 7988,
      code: "C-7988",
      entityId: "C-7988",
      name: "Alpha Stone Inc.",
      companyName: "Alpha Stone Inc.",
      phone: "(416) 555-0101",
      address: ""
    },
    "The exact NetSuite internal ID must remain the Return customer key."
  );
  assert.throws(
    () => validateReturnCustomerDirectorySnapshot([]),
    /existing Return customer directory was preserved/i,
    "An empty remote response must never be treated as a successful replacement."
  );
  assert.throws(
    () => validateReturnCustomerDirectorySnapshot([{ id: "not-an-id" }]),
    /invalid customer internal ID/i
  );

  assert.match(migration, /netsuite_customer_id bigint PRIMARY KEY/);
  assert.match(migration, /idx_return_customer_directory_entity_code/);
  assert.match(migration, /idx_return_customer_directory_company_name/);
  assert.match(migration, /idx_return_customer_directory_phone/);
  assert.match(directorySource, /DELETE FROM return_customer_directory[\s\S]*sync_generation IS DISTINCT FROM/);
  assert.match(directorySource, /fetchReturnCustomersFromNetSuite[\s\S]*kickReturnCustomerDirectoryRefresh/);
  assert.match(netSuiteSource, /fetchActiveReturnCustomerDirectoryFromNetSuite[\s\S]*c\.isinactive = 'F'/);
  assert.match(repositorySource, /return searchReturnCustomerDirectory\(search, options\)/);
  assert.match(
    repositorySource,
    /fetchReturnCustomerFromNetSuite\(input\.customerId,\s*\{\s*force:\s*true\s*\}\)/,
    "Submission must continue to revalidate a customer live by exact NetSuite internal ID."
  );
  assert.match(serverSource, /setTimeout\(\(\) => void returnCustomerDirectorySyncTick\(\), 15000\)/);
  assert.match(serverSource, /setInterval\(\(\) => void returnCustomerDirectorySyncTick\(\), 5 \* 60 \* 1000\)/);
}

async function databaseTests() {
  await withTransaction(async () => {
    await query(migration);
    await query("DELETE FROM return_customer_directory");
    await query(
      `UPDATE return_customer_directory_sync
          SET status = 'idle',
              current_run_token = NULL,
              last_started_at = NULL,
              last_completed_at = NULL,
              last_successful_at = NULL,
              last_error = NULL,
              customer_count = 0`
    );

    await upsertReturnCustomerDirectoryEntries([
      {
        id: 7988,
        entityId: "C-ALPHA",
        companyName: "Alpha Stone Incorporated",
        phone: "(416) 555-0101",
        address: "1 Alpha Street"
      },
      {
        id: 7990,
        entityId: "BETA-01",
        companyName: "Beta Masonry",
        phone: "+1 905 555 0188",
        address: "2 Beta Road"
      }
    ]);

    const exactIdMatches = await searchLocalReturnCustomerDirectory("7988");
    assert.equal(exactIdMatches[0].internalId, 7988);
    assert.equal(exactIdMatches.length, 1, "An existing exact NetSuite internal ID must return only that customer.");
    assert.equal((await getLocalReturnCustomerById(7988)).entityId, "C-ALPHA");
    assert.equal((await searchLocalReturnCustomerDirectory("c-alpha"))[0].companyName, "Alpha Stone Incorporated");
    assert.equal((await searchLocalReturnCustomerDirectory("STONE"))[0].id, 7988);
    assert.equal((await searchLocalReturnCustomerDirectory("5550101"))[0].id, 7988);
    assert.equal((await searchLocalReturnCustomerDirectory("masonry"))[0].id, 7990);

    await assert.rejects(
      syncReturnCustomerDirectory({
        force: true,
        directAccessEnabled: true,
        fetchCustomers: async () => []
      }),
      /existing Return customer directory was preserved/i
    );
    assert.equal(
      Number((await query("SELECT COUNT(*)::int AS count FROM return_customer_directory")).rows[0].count),
      2,
      "A failed/empty refresh must leave the last searchable rows intact."
    );
    assert.equal(
      (await searchLocalReturnCustomerDirectory("7988"))[0].id,
      7988,
      "Local search must remain available after refresh failure."
    );

    const refreshed = await syncReturnCustomerDirectory({
      force: true,
      directAccessEnabled: true,
      fetchCustomers: async () => [
        {
          id: 7988,
          entityId: "C-ALPHA",
          companyName: "Alpha Stone Updated",
          phone: "4165550101"
        },
        {
          id: 8001,
          entityId: "NEW-01",
          companyName: "New Active Customer",
          phone: "6475550199"
        }
      ]
    });
    assert.equal(refreshed.refreshed, 2);
    assert.equal((await searchLocalReturnCustomerDirectory("updated"))[0].id, 7988);
    assert.deepEqual(
      (await query(
        "SELECT netsuite_customer_id::text AS id FROM return_customer_directory ORDER BY netsuite_customer_id"
      )).rows.map((row) => row.id),
      ["7988", "8001"],
      "Customers absent from NetSuite are removed only after a complete successful snapshot."
    );
    const state = (await query(
      `SELECT status, customer_count, last_successful_at
         FROM return_customer_directory_sync
        WHERE singleton_id = 1`
    )).rows[0];
    assert.equal(state.status, "succeeded");
    assert.equal(Number(state.customer_count), 2);
    assert.ok(state.last_successful_at);
  }, { rollback: true });
}

pureTests();
try {
  await databaseTests();
  console.log("Return customer directory harness passed.");
} finally {
  await closeDb();
}
