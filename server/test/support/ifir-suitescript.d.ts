// Minimal declarations for the N/* boundary used by this standalone script.
// These validate API call shapes; they do not replace NetSuite sandbox proof.
interface NSRecord {
  id: number | string;
  type: string;
  getValue(input: { fieldId: string }): any;
  getText(input: { fieldId: string }): string;
  setValue(input: { fieldId: string; value: any }): NSRecord;
  getLineCount(input: { sublistId: string }): number;
  getSublistValue(input: { sublistId: string; fieldId: string; line: number }): any;
  getSublistText(input: { sublistId: string; fieldId: string; line: number }): string;
  setSublistValue(input: { sublistId: string; fieldId: string; line: number; value: any }): NSRecord;
  hasSublistSubrecord(input: { sublistId: string; fieldId: string; line: number }): boolean;
  getSublistSubrecord(input: { sublistId: string; fieldId: string; line: number }): NSRecord;
  save(input: { enableSourcing: boolean; ignoreMandatoryFields: boolean }): number;
}
interface NSRecordModule {
  Type: Record<string, string>;
  load(input: { type: string; id: number; isDynamic: boolean }): NSRecord;
  transform(input: { fromType: string; fromId: number; toType: string; isDynamic: boolean }): NSRecord;
}
interface IFIRSelection {
  orderLine: number;
  itemReceive: boolean;
  quantity?: number;
  location?: number;
  [key: string]: any;
}
interface IFIRRequest {
  action: 'post';
  sourceOrderKind: 'PO' | 'SO' | 'TO';
  transactionType: 'IF' | 'IR';
  sourceNetSuiteId: number;
  payload: {
    externalId: string;
    memo?: string;
    custbody9?: string;
    inventoryLocation?: number | { id: string | number };
    shipStatus?: string;
    item: { items: IFIRSelection[] };
  };
}
interface IFIRState { stage: string; id: number | null; saveAttempted: boolean }
interface IFIRClassification { itemType: string; itemSubtype?: string; generateAccruals?: boolean | null }
interface IFIRSavedLine extends IFIRClassification {
  orderLine: number | null;
  line: number | null;
  lineUniqueKey: string | null;
  item: { id: string | null; refName: string };
  itemReceive: boolean | null;
  quantity: number | null;
  location: { id: string | null };
  units: { id: string | null; refName: string };
  unitsDisplay: string;
  orderDoc: { id: string | null };
  itemUnitPrice: number | null;
  itemFxAmount: number | null;
  inventoryDetail: any;
  [key: string]: any;
}
declare function define(names: string[], factory: (record: NSRecordModule,
  search: { Type: Record<string, string>; create(input: { type: string; filters: any[]; columns: string[] }): {
    run(): { getRange(input: { start: number; end: number }): { id: string; recordType: string; getValue(input: { name: string }): any }[] }
  } },
  runtime: { envType: string; EnvType: Record<string, string>; getCurrentScript(): { getParameter(input: { name: string }): any } },
  log: { audit(input: { title: string; details: any }): void; error(input: { title: string; details: any }): void }
) => { get: () => any; post: (input: any) => any }): void;
