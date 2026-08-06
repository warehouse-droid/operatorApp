// @ts-check

import { serializeCsv } from "../../../src/mbt/bounded-csv.js";

export const RATE_CARD_CSV_HEADERS = Object.freeze({
  rate_cards: Object.freeze([
    "rate_card_code", "display_name", "description", "customer_netsuite_id",
    "subsidiary_netsuite_id", "service_template_code", "currency", "active",
    "version_number", "effective_from", "effective_to",
    "default_rental_calendar_days", "calculation_notes"
  ]),
  distance_bands: Object.freeze([
    "service_code", "bin_type_code", "sequence_number", "minimum_metres",
    "maximum_metres", "amount_minor", "downtown_surcharge_minor", "currency",
    "description"
  ]),
  components: Object.freeze([
    "component_code", "component_kind", "service_code", "bin_type_code",
    "rate_basis", "amount_minor", "percentage_basis_points", "default_quantity",
    "currency", "taxable", "active", "description"
  ]),
  dump_tariffs: Object.freeze([
    "dump_site_code", "material_code", "tariff_code", "pricing_basis",
    "unit_of_measure", "amount_minor", "minimum_amount_minor", "currency",
    "active", "description"
  ]),
  deposit_rules: Object.freeze([
    "rule_code", "rule_type", "bin_type_code", "service_code",
    "fixed_amount_minor", "percentage_basis_points", "currency",
    "liability_account_mapping_key", "active", "description"
  ])
});

export const RATE_CARD_CSV_FILE_NAMES = Object.freeze({
  rate_cards: "rate_cards.csv",
  distance_bands: "distance_bands.csv",
  components: "components.csv",
  dump_tariffs: "dump_tariffs.csv",
  deposit_rules: "deposit_rules.csv"
});

/** @param {string} suffix */
export function rateCardCsvRows(suffix = "A") {
  const code = `P36CSV_${suffix}`.replaceAll("-", "_").toUpperCase();
  return {
    rate_cards: [{
      rate_card_code: code,
      display_name: `Synthetic CSV rate ${suffix}`,
      description: "Five-file local import",
      customer_netsuite_id: "",
      subsidiary_netsuite_id: "",
      service_template_code: "",
      currency: "CAD",
      active: "true",
      version_number: "1",
      effective_from: "2036-08-03T00:00:00.000Z",
      effective_to: "",
      default_rental_calendar_days: "14",
      calculation_notes: "Raw metres and integer CAD cents"
    }],
    distance_bands: [
      {
        service_code: "delivery",
        bin_type_code: "14YD",
        sequence_number: "1",
        minimum_metres: "10000",
        maximum_metres: "",
        amount_minor: "18000",
        downtown_surcharge_minor: "2500",
        currency: "CAD",
        description: "Extended"
      },
      {
        service_code: "delivery",
        bin_type_code: "14YD",
        sequence_number: "0",
        minimum_metres: "0",
        maximum_metres: "10000",
        amount_minor: "12000",
        downtown_surcharge_minor: "1500",
        currency: "CAD",
        description: "Local"
      }
    ],
    components: [
      {
        component_code: "permit_fee",
        component_kind: "service",
        service_code: "",
        bin_type_code: "",
        rate_basis: "flat",
        amount_minor: "900",
        percentage_basis_points: "",
        default_quantity: "1.0000",
        currency: "CAD",
        taxable: "false",
        active: "true",
        description: "Permit"
      },
      {
        component_code: "fuel_percent",
        component_kind: "other",
        service_code: "delivery",
        bin_type_code: "14YD",
        rate_basis: "percentage",
        amount_minor: "",
        percentage_basis_points: "500",
        default_quantity: "1.0000",
        currency: "CAD",
        taxable: "true",
        active: "true",
        description: "Fuel"
      }
    ],
    dump_tariffs: [{
      dump_site_code: `P36DUMP_${suffix}`.replaceAll("-", "_").toUpperCase(),
      material_code: `P36MAT_${suffix}`.replaceAll("-", "_").toUpperCase(),
      tariff_code: "clean_fill_tonne",
      pricing_basis: "per_quantity",
      unit_of_measure: "TONNE",
      amount_minor: "2500",
      minimum_amount_minor: "16000",
      currency: "CAD",
      active: "true",
      description: "Clean fill"
    }],
    deposit_rules: [{
      rule_code: "initial_14yd",
      rule_type: "bin_type",
      bin_type_code: "14YD",
      service_code: "",
      fixed_amount_minor: "25000",
      percentage_basis_points: "",
      currency: "CAD",
      liability_account_mapping_key: "",
      active: "true",
      description: "Initial deposit"
    }]
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.suffix]
 * @param {boolean} [options.minimal]
 * @param {Record<string, readonly Record<string, unknown>[]>} [options.rows]
 */
export function buildRateCardCsvFiles({ suffix = "A", minimal = false, rows: suppliedRows } = {}) {
  const rows = suppliedRows || rateCardCsvRows(suffix);
  const selected = minimal
    ? { ...rows, components: [], dump_tariffs: [], deposit_rules: [] }
    : rows;
  return Object.fromEntries(Object.entries(RATE_CARD_CSV_HEADERS).map(([key, headers]) => [
    key,
    {
      fileName: RATE_CARD_CSV_FILE_NAMES[key],
      content: serializeCsv({ headers, rows: selected[key] || [], protectFormulae: false })
    }
  ]));
}

/** @param {string} suffix */
export function expectedRateCardGraph(suffix = "A") {
  const rows = rateCardCsvRows(suffix);
  const card = rows.rate_cards[0];
  return {
    rateCard: {
      rateCardCode: card.rate_card_code,
      displayName: card.display_name,
      description: card.description,
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: 1,
      effectiveFrom: card.effective_from,
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: card.calculation_notes
    },
    distanceBands: [
      {
        serviceCode: "delivery",
        binTypeCode: "14YD",
        sequenceNumber: 0,
        minimumMetres: 0,
        maximumMetres: 10_000,
        amountMinor: 12_000,
        downtownSurchargeMinor: 1_500,
        currency: "CAD",
        description: "Local"
      },
      {
        serviceCode: "delivery",
        binTypeCode: "14YD",
        sequenceNumber: 1,
        minimumMetres: 10_000,
        maximumMetres: null,
        amountMinor: 18_000,
        downtownSurchargeMinor: 2_500,
        currency: "CAD",
        description: "Extended"
      }
    ],
    components: [
      {
        componentCode: "fuel_percent",
        componentKind: "other",
        serviceCode: "delivery",
        binTypeCode: "14YD",
        rateBasis: "percentage",
        amountMinor: null,
        percentageBasisPoints: 500,
        defaultQuantity: "1.0000",
        currency: "CAD",
        taxable: true,
        active: true,
        description: "Fuel"
      },
      {
        componentCode: "permit_fee",
        componentKind: "service",
        serviceCode: null,
        binTypeCode: null,
        rateBasis: "flat",
        amountMinor: 900,
        percentageBasisPoints: null,
        defaultQuantity: "1.0000",
        currency: "CAD",
        taxable: false,
        active: true,
        description: "Permit"
      }
    ],
    dumpTariffs: [{
      dumpSiteCode: rows.dump_tariffs[0].dump_site_code,
      materialCode: rows.dump_tariffs[0].material_code,
      tariffCode: "clean_fill_tonne",
      pricingBasis: "per_quantity",
      unitOfMeasure: "TONNE",
      amountMinor: 2_500,
      minimumAmountMinor: 16_000,
      currency: "CAD",
      active: true,
      description: "Clean fill"
    }],
    depositRules: [{
      ruleCode: "initial_14yd",
      ruleType: "bin_type",
      binTypeCode: "14YD",
      serviceCode: null,
      fixedAmountMinor: 25_000,
      percentageBasisPoints: null,
      currency: "CAD",
      liabilityAccountMappingKey: "",
      active: true,
      description: "Initial deposit"
    }]
  };
}
