"""Independent Decimal oracle for captured delivery packing quantities."""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "server/test-artifacts/group-underpack-20260915"
UNITS = [("pallet", "to_plt"), ("layer", "to_lyr"), ("section", "to_sec"), ("piece", "to_pcs")]
EPSILON = Decimal("0.000001")


def number(value):
    return abs(Decimal(str(value or 0)))


def line_result(line):
    conversions = [number(line[column]) for _, column in UNITS]
    custom = [number(line[f"{unit}_qty"]) for unit, _ in UNITS]
    packed_units = [number(line[f"packed_{unit}_qty"]) for unit, _ in UNITS]
    sales = number(line["packed_sales_qty"])
    converted = any(conversions)
    legacy = str(line["sku"] or line["item_name"] or "").strip().upper() == "PALLET" or not any(custom)
    packed = sum(value * conversion for value, conversion in zip(packed_units, conversions)) if converted else sales
    if not converted and not sales and legacy:
        packed = next((value for value in reversed(packed_units) if value), Decimal(0))
    required = number(line["quantity"]) or sum(value * conversion for value, conversion in zip(custom, conversions))
    loaded = number(line["loaded_qty"])
    residual = (required - loaded - packed).quantize(EPSILON, rounding=ROUND_HALF_UP)
    rounding = packed > 0 and converted and residual <= Decimal("0.1") and residual < min(value for value in conversions if value)
    remaining = Decimal(0) if residual <= EPSILON or rounding else residual
    pickable = line["item_type"] in ["InvtPart", "NonInvtPart"]
    name = str(line["sku"] or line["item_name"] or "").strip().upper()
    group_pickable = pickable and not name.startswith(("DELIVERY CHARGE", "SALES CREDIT"))
    return {"lineId": line["id"], "required": str(required), "packed": str(packed), "loaded": str(loaded),
            "residual": str(residual), "remaining": str(remaining), "roundingCorrection": residual > EPSILON and remaining == 0,
            "pickable": pickable, "groupPickable": group_pickable, "active": bool(line["netsuite_active"]),
            "hasPacked": bool(any(packed_units) or sales), "hasLoaded": loaded > 0}


def main():
    raw = (ARTIFACT / "replay-input.json").read_bytes()
    data = json.loads(raw)
    rows = []
    for order in data["orders"]:
        lines = [line_result(line) for line in order["lines"]]
        active = [line for line in lines if line["pickable"] and line["active"]]
        progress = any(line["hasPacked"] or line["hasLoaded"] for line in active)
        group_progress = any(line["hasPacked"] or line["hasLoaded"] for line in lines)
        group_open = any(Decimal(line["remaining"]) > 0 for line in lines if line["groupPickable"])
        rows.append({"id": order["netsuite_id"], "ref": order["tranid"], "lines": lines,
                     "beforeUnderpack": sum(Decimal(line["residual"]) > EPSILON for line in active) if progress else 0,
                     "afterUnderpack": sum(Decimal(line["remaining"]) > 0 for line in active) if progress else 0,
                     "groupUnderpack": int(group_progress and group_open)})
    report = {"inputSha256": hashlib.sha256(raw).hexdigest(), "orders": rows}
    (ARTIFACT / "replay-oracle.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"orders": len(rows), "lines": sum(len(row["lines"]) for row in rows),
                      "roundingLines": sum(line["roundingCorrection"] for row in rows for line in row["lines"]),
                      "changedOrderCounts": sum(row["beforeUnderpack"] != row["afterUnderpack"] for row in rows)}))


if __name__ == "__main__":
    main()
