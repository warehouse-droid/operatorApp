# MBT item-owned pricing acceptance contract

This contract is the durable scenario catalog for item and rate-card pricing.
Add a scenario here before changing a money rule.

| Scenario | Item setting | Rate-card evidence | Customer unit |
| --- | --- | --- | --- |
| Garbage dump | No dump line | No dump tariff required | none |
| Soil/asphalt/concrete fixed dump | Dump + `per_bin` | `per_quantity` / `BIN` | one configured amount per bin |
| Weighed dump material | Dump + `per_tonne` | `per_weight` / `TONNE` | configured amount times tonnes |
| Aggregate material | Aggregate + `per_yard` + positive density | `per_quantity` / `YARD` | configured amount times yards |
| Aggregate with first delivery | Aggregate material plus one visit surcharge | item rate plus CAD 50 loading fee | yards plus one loading event |
| Aggregate with exchange | Aggregate material plus one visit surcharge | item rate plus CAD 50 loading fee | yards plus one loading event |
| Standalone aggregate delivery | Delivery fee distance item | first 30 km CAD 150, later configured bands | one distance-band charge |

Changing an item's current charging basis controls only new rate-card input.
Every previously activated rate-card version and every confirmed charge keeps
its stored pricing basis, UOM, amount, and calculation snapshot unchanged.

Cash prices include HST and remain local-only. Non-cash prices are pre-tax,
add 13% HST exactly once in the local customer total, and may become eligible
for a future NetSuite Sales Order. This release creates no NetSuite work.
