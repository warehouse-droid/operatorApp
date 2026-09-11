export function liveRoutePlan() {
  return {
    id: "313",
    planDate: "2026-09-08",
    revision: 17,
    orders: [
      { id: "SN1399919", type: "SO", items: [{ sku: "STONE-A", pallets: 1 }] },
      { id: "3022191978", type: "SO", items: [{ sku: "STONE-B", pallets: 4 }] },
      { id: "SN1399999", type: "SO", items: [{ sku: "STONE-C", pallets: 2 }] }
    ],
    trucks: [{
      id: "truck-bl42349",
      plate: "BL42349",
      driverLogin: "mike",
      driver: "Mike",
      base: "12441",
      loads: [
        {
          id: "load-1-empty",
          name: "Load 1",
          driverLogin: "mike",
          driverSequence: 0,
          plannedStartMinute: 420,
          plannedFinishMinute: 450,
          stops: [],
          orders: []
        },
        {
          id: "load-1-sn1399919",
          name: "Load 1 correction",
          driverLogin: "mike",
          driverSequence: 1,
          plannedStartMinute: 460,
          plannedFinishMinute: 520,
          stops: [
            { id: "pick-sn1399919", type: "pick", orderId: "SN1399919", location: "12441", instructions: "Original pickup" },
            { id: "drop-sn1399919", type: "drop", orderId: "SN1399919", location: "Old customer", instructions: "Keep original evidence" }
          ],
          orders: [{ id: "SN1399919", items: [{ sku: "STONE-A", pallets: 1 }] }]
        },
        {
          id: "load-2-active",
          name: "Load 2",
          driverLogin: "mike",
          driverSequence: 2,
          plannedStartMinute: 540,
          plannedFinishMinute: 660,
          stops: [
            { id: "pick-active", type: "pick", orderId: "3022191978", location: "12441", instructions: "Load at yard" },
            { id: "drop-active", type: "drop", orderId: "3022191978", location: "UNILOCK Gormley", instructions: "Current stop" },
            { id: "drop-future", type: "drop", orderId: "SN1399999", location: "Future customer", instructions: "Future stop" }
          ],
          orders: [
            { id: "3022191978", items: [{ sku: "STONE-B", pallets: 4 }] },
            { id: "SN1399999", items: [{ sku: "STONE-C", pallets: 2 }] }
          ]
        },
        {
          id: "load-3-future",
          name: "Load 3",
          driverLogin: "mike",
          driverSequence: 3,
          plannedStartMinute: 700,
          plannedFinishMinute: 760,
          stops: [{ id: "drop-later", type: "drop", orderId: "LATER", location: "Later customer" }],
          orders: [{ id: "LATER" }]
        }
      ]
    }]
  };
}

export function activeDropRecord(overrides = {}) {
  return {
    job_id: "313:truck-bl42349:load-2-active:drop-active",
    plan_id: 313,
    plan_date: "2026-09-08",
    driver_login: "mike",
    truck_id: "truck-bl42349",
    truck_plate: "BL42349",
    load_id: "load-2-active",
    load_name: "Load 2",
    stop_id: "drop-active",
    stop_type: "dropoff",
    order_refs: ["3022191978"],
    status: "in_progress",
    started_at: "2026-09-08T15:10:00.000Z",
    completed_at: null,
    job_details: {
      physicalVisitJobIds: ["313:truck-bl42349:load-2-active:drop-active"]
    },
    ...overrides
  };
}

export function cursorJobs() {
  return [
    { jobId: "load-1-old", loadId: "load-1-sn1399919", stopId: "drop-sn1399919", stopType: "dropoff" },
    {
      jobId: "load-2-current",
      loadId: "load-2-active",
      stopId: "drop-active",
      stopType: "dropoff",
      physicalVisitJobIds: ["load-2-current"]
    },
    { jobId: "load-2-future", loadId: "load-2-active", stopId: "drop-future", stopType: "dropoff" },
    { jobId: "load-3-future", loadId: "load-3-future", stopId: "drop-later", stopType: "dropoff" }
  ];
}
