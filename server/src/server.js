import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config, isNetSuiteSandboxEnvironment, listEnvFiles, selectEnvFile } from "./config.js";
import { createMbtRouter } from "./mbt/router.js";
import { confirmMbtBinDispatchPlan } from "./mbt/bin-dispatch-service.js";
import { binDispatchOrders } from "./mbt/dispatch-bin-safety.js";
import { authorizeMbtPhase3Capability } from "./mbt/phase3-authorization.js";
import { afterTransactionCommit, beginRollbackContext, pool, query, withTransaction } from "./db.js";
import { fetchSalesOrderReferenceFromNetSuite, fetchTransactionReferenceByTranidFromNetSuite } from "./netsuite.js";
import { buildAuthorizationUrl, exchangeCodeForToken, fetchDeliveryOrdersFromNetSuite, fetchDeliveryOrderFromNetSuite, fetchCustomerPickupOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, fetchDeliveryOrderDetailsBatchFromNetSuite, fetchTransferDeliveryOrdersFromNetSuite, fetchTransferDeliveryOrderFromNetSuite, fetchTransferOrderDetailsFromNetSuite, fetchTransferOrderVerificationLinesFromNetSuite, fetchTransferOrderByIdFromNetSuite, findTransferOrdersByDependencyMarkerFromNetSuite, findTransferOrdersBySmartScmMarkerFromNetSuite, fetchPurchaseOrdersFromNetSuite, fetchPurchaseOrderFromNetSuite, fetchPurchaseOrderReferenceFromNetSuite, fetchPurchaseOrderDetailsFromNetSuite, fetchTransferReceivingOrdersFromNetSuite, fetchTransferReceivingOrderFromNetSuite, fetchInventoryBalanceForItemFromNetSuite, fetchInventoryBalancesFromNetSuite, fetchInventoryBalancesForItemsFromNetSuite, fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite, fetchTransactionProgressFromNetSuite, fetchTransactionStatusFromNetSuite, createPurchaseOrderInNetSuite, createTransferOrderInNetSuite, updateTransferOrderStatusInNetSuite, fetchPickingTicketFromNetSuite, resolveNetSuiteTransferLocations, resolveNetSuiteYardLocations, resolvePalletItemFromNetSuite, transformSalesOrderToItemFulfillment, transformTransferOrderToItemFulfillment, transformPurchaseOrderToItemReceipt, transformTransferOrderToItemReceipt } from "./netsuite.js";
import { buildTransferDependencyRestPayload, selectSmartScmMarkerTransferOrder, smartScmTransferOrderMemoMarker, transferDependencyMemoMarker } from "./transfer-dependency-netsuite.js";
import {
  assertScmReconciliationOrderEditable,
  cancelScmReconciliationRun,
  enrichScmScheduleWithReconciliation,
  getScmReconciliationRunDetails,
  getScmReconciliationPreference,
  getScmReconciliationSettings,
  listScmPoSplitLineAdjustmentOptions,
  listScmReconciliationRuns,
  reassignScmPoSplitLineSource,
  resolveScmReconciliationReview,
  storeScmIfIrWebhook,
  updateScmReconciliationPreference,
  updateScmReconciliationRunTargetDecision,
  updateScmReconciliationSettings,
  verifyScmIfIrWebhookSignature
} from "./scm-reconciliation-repository.js";
import {
  applyScmReconciliationRun,
  cancelMissingScmPurchaseOrder,
  executeScmReconciliationRun,
  processScmIfIrWebhookResult,
  resumeScmReconciliationRun,
  retryScmReconciliationOrder,
  scmReconciliationNightlyTick,
  startScmReconciliationRun
} from "./scm-reconciliation-service.js";
import {
  isBilledSalesOrderIdentifier,
  listBilledSalesOrderFamilyRefs
} from "./sales-order-reconciliation-repository.js";
import { isNetSuiteSalesOrderBilled } from "./sales-order-reconciliation.js";
import { getScmSchedulePreference, normalizeScmSchedulePreferenceSurface, updateScmSchedulePreference } from "./scm-schedule-preference-repository.js";
import { getScmScheduleFormatting, updateScmScheduleFormatting } from "./scm-schedule-formatting-repository.js";
import { canViewRestrictedScmOrders, filterRestrictedScmOrders } from "./scm-order-visibility.js";
import { changedPlacedDispatchScmAssignmentRefs } from "./dispatch-scm-placement.js";
import { syncTargetedNetSuiteOrder } from "./targeted-order-sync.js";
import { listDeliveryOrders, listVrmaDeliveryPrepOrders, getDeliveryOrder, getFulfillableDeliveryOrder, buildItemFulfillmentPayload, markDeliveryPrepared, updateDeliveryStatus, confirmDeliveryLine, confirmDeliveryLines, setDeliveryLinePackedQuantity, unpackDeliveryLine, unpackDeliveryOrder, recordDeliveryFulfillment, recordDeliveryFulfillmentFailure, recordDeliveryLoad, listDeliveryFulfillments, getDeliveryBootstrap, getDeliveryPrepNotifications, resetDeliveryFulfillmentState, applyConfirmedDispatchPlanToDelivery, deactivateUnplannedDispatchSplitOrders, getNextDispatchSplitSuffix, getCurrentOperatorDeliveryDraft, releaseCurrentDeliveryDraft, listSavedDeliveryOrdersForOperator, listSavedDeliveryOrderKeysForOperator, saveDeliveryOrderForOperator, removeSavedDeliveryOrderForOperator, listDeliveryLoadTrucks, listDeliveryLoadOrders } from "./delivery-repository.js";
import { getYardMovementDetail, listYardMovementCsvRows, listYardMovements } from "./yard-movement-repository.js";
import { yardMixedUnits } from "./yard-quantity.js";
import { clearCustomerPickupDraft, confirmCustomerPickupLine, findCustomerPickupOrder, isPendingApprovalStatus, isPickupDeliveryMethod, recordCustomerPickupLoad } from "./customer-pickup-repository.js";
import { createOperator, getOperatorByToken, hasOperators, listAudit, listAuditOptions, listOperators, loginOperator, logoutToken, operatorHomeRoute, setOperatorActive, updateOperatorPassword, updateOperatorRoles, writeAudit } from "./auth-repository.js";
import { applyInventoryClassificationRules, confirmCycleCountLine, getCycleCountDraft, listCycleCountRecords, listInventoryClassifications, listInventoryFacets, listInventoryItems, submitCycleCount, updateInventoryClassification, upsertInventoryBalances } from "./inventory-repository.js";
import { listReceivingVendors, listReceivingSources, listReceivingOrders, getReceivingOrder, searchReceivingItems, confirmReceivingLine, unconfirmReceivingLine, getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt, recordReceivingReceiptFailure, listReceivingReceipts, listLocalCoSources, listLocalCoReceivingOrders, searchLocalCoItems, getLocalCoReceivingOrder, confirmLocalCoReceivingLine, unconfirmLocalCoReceivingLine, receiveLocalCoOrder } from "./receiving-repository.js";
import { listExistingInboundOrderIds, listExistingOutboundOrderIds, markMissingInboundOrderLines, markMissingInboundOrders, markMissingOutboundOrderLines, markOutboundOrderMissing, updatePurchaseOrderNetSuiteStatus, updateSalesOrderNetSuiteStatus, upsertInboundTransferOrderLines, upsertInboundTransferOrders, upsertOutboundTransferOrderLines, upsertOutboundTransferOrders, upsertPurchaseOrderLines, upsertPurchaseOrders, upsertSalesOrderLines, upsertSalesOrders } from "./order-sync-repository.js";
import { acceptNetSuiteMirrorEvents, enqueueNetSuiteMirrorOrderEvent, getNetSuiteMirrorStatus, isNetSuiteMirrorConsumer, isNetSuiteMirrorSource, listNetSuiteMirrorManifest, retryNetSuiteMirrorFailures } from "./netsuite-mirror-repository.js";
import { kickNetSuiteMirrorConsumer, localNetSuiteMirrorEventPage, localNetSuiteMirrorInventorySnapshot, localNetSuiteMirrorOrderSnapshot, relayPendingNetSuiteMirrorEvents, requireNetSuiteMirrorSignature, runNetSuiteMirrorConsumerTick, runNetSuiteMirrorReconciliation, startNetSuiteMirrorWorkers } from "./netsuite-mirror-service.js";
import { listOperatorHistory, listRecordWarnings, reportOperatorRecordError, resolveRecordWarning } from "./history-repository.js";
import { listDispatchOrders, enrichDispatchOrdersWithPoTargetAllocations, listScmPurchaseOrders, listScmSchedule, updateScmScheduleEntry, createScmScheduleGroup, cancelScmScheduleGroup, listScmViewPresets, upsertScmViewPreset, completeScmVrmaOrderOverride, createScmVrmaOrder, getScmVrmaOrder, getScmVrmaOptions, removeScmVrmaOrder, searchScmVrmaItems, syncScmScheduleFromDispatchPlan, createScmPurchaseOrderSplit, updateScmPurchaseOrderSplitRef, updateScmPurchaseOrderSplitDestination, updateScmPurchaseOrderSplitPickupYard, updatePurchaseOrderDispatchRef, cancelScmPurchaseOrderSplit, refreshDispatchEnrichment, reparseMissingSalesOrderDispatch, searchSalesOrderMethodOverrides, setPurchaseOrderVendorYard, updateDispatchOrderDetails, updateSalesOrderLocalMethod, getSalesOrderPoAllocationOptions, createSalesOrderPoAllocation, createSalesOrderPoAllocations, cancelSalesOrderPoAllocation, createDispatchOperatorRequest, upsertLocalCoOrder, cancelLocalCoOrder, listDispatchOperatorRequests, resolveDispatchOperatorRequestsForOrder } from "./dispatch-repository.js";
import { setPurchaseOrderBlanketFlag } from "./dispatch-repository.js";
import { cancelDispatchCustomOrder, canonicalizeDispatchCustomOrdersInPlan, completeDispatchCustomOrders, createDispatchCustomOrder, dispatchOrderFromCustomOrder, getDispatchCustomOrderForUpdate, listDispatchCustomOrders, updateDispatchCustomOrder } from "./dispatch-custom-order-repository.js";
import { DISPATCH_VENDOR_WEEK_DAYS, listDispatchVendorYards, listDispatchLocalVendors, saveDispatchVendorYardSchedule, updateDispatchVendorYard, upsertDispatchVendorYard, listDispatchParserRules, updateDispatchParserRule, listOllamaAudit, listDispatchVendorMappings, discoverDispatchVendorMappingsFromPurchaseOrders, updateDispatchVendorMapping, createDispatchLocalVendor, updateDispatchLocalVendor } from "./dispatch-enrichment.js";
import { listDispatchAudit, writeDispatchAudit } from "./dispatch-audit-repository.js";
import { runWithAuditContext } from "./audit-context.js";
import { DispatchPlanDateMismatchError, StaleDispatchPlanSaveError, applyDispatchPlannedAssignment, cleanupBilledSalesOrderFamiliesFromDispatchPlan, confirmDispatchPlan, createDispatchPlan, dispatchPlannedAssignmentMap, dispatchPlannedOrderConflictRefs, dispatchPlannedOrderRefs, getCurrentDispatchPlan, getDispatchPlan, getDispatchPlanRevision, getDispatchPlanSnapshot, listDispatchPlanSnapshots, listDispatchPlans, reopenDispatchPlan, restoreDispatchPlanSnapshot, saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import {
  advanceDispatchV2Followup,
  applyDispatchV2Command,
  completeDispatchV2Followup,
  failDispatchV2Followup,
  getDispatchV2CommandReplay,
  getDispatchV2Bootstrap,
  getDispatchV2Checkpoint,
  listDispatchV2Checkpoints,
  pendingDispatchV2Followups,
  pruneExpiredDispatchV2Checkpoints
} from "./dispatch-planner-v2-repository.js";
import { evaluateExecutedPrefixPolicy } from "./dispatch-planner-performance.js";
import { DispatchPlanEditLeaseError, acquireDispatchPlanEditLease, assertDispatchPlanEditLease, getDispatchPlanEditLease, heartbeatDispatchPlanEditLease, releaseDispatchPlanEditLease } from "./dispatch-plan-lease-repository.js";
import { getDispatchStatistics } from "./dispatch-statistics-repository.js";
import { buildDispatchForecast } from "./dispatch-forecast-service.js";
import { DISPATCH_FLEET_PLANNING_LOCK, dispatchFleetAssignmentStatusConflicts, dispatchFleetPlanConflicts, dispatchLegacyDriverRenameConflicts, unchangedCompletedDispatchLoadIds } from "./dispatch-fleet-status.js";
import { syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";
import { confirmDriverTruckSwitch, endDriverRest, ensureDriverSamsaraDutyForJob, getActiveDriverRest, getDriverDayJobs, getDriverDayState, getDriverNextJobContext, getDriverRestSummary, getNextDriverJob, listDriverHistory, listDriverJobStatuses, listDriverTruckSwitchAttention, overrideDriverTruckSwitch, recordDriverJobPhotos, recordOfflineDriverTruckSwitch, skipDriverDvirForTesting, skipDriverTruckSwitchSamsara, startDriverJob, startDriverRest, submitDriverDvir } from "./driver-repository.js";
import {
  authorizeDriverOfflineSync,
  authorizeOfflinePhotoUpload,
  beginDriverOfflineRetry,
  completeDriverOfflineRetry,
  createDriverSession,
  createDriverLocationVerification,
  driverOfflineManifestMatchesJobs,
  findDriverOfflineRebaseCandidates,
  findOpenDriverOfflineJobCompletion,
  failDriverOfflineRetry,
  getDriverOfflineEvent,
  getDriverOfflinePhotoRegistration,
  getDriverOfflineManifest,
  getDriverOfflineReview,
  getDriverOfflineReviewCounts,
  getDriverSession,
  getLatestDriverOfflineManifest,
  getDriverOfflineSyncSummary,
  driverOfflineRouteBootstrap,
  dismissDriverClientSyncIssue,
  issueDriverOfflineSyncGrant,
  listDriverClientSyncIssues,
  listDriverOfflineReviews,
  markDriverOfflinePhotoDurable,
  materializeDriverOfflineJobs,
  normalizeDriverDeviceId,
  normalizePlanDate,
  persistDriverOfflineBootstrap,
  persistDriverOfflineDayPlan,
  registerDriverOfflineSync,
  recordDriverClientSyncStatus,
  recordDriverOfflinePhotoVerificationFailure,
  resolveDriverOfflineReview,
  revokeDriverOfflineGrants,
  revokeDriverSession,
  revokeDriverSessionsForLogin
} from "./driver-offline-repository.js";
import { listDriverPwaStops, reopenDriverPwaStop } from "./driver-pwa-repository.js";
import { processDriverOfflineQueue } from "./driver-offline-service.js";
import {
  DRIVER_PWA_CURRENT_VERSION,
  DRIVER_PWA_MINIMUM_VERSION,
  DRIVER_PWA_VERSION_HEADER,
  driverPwaVersionDetails,
  driverPwaVersionGate
} from "./driver-client-version.js";
import { getDriverOfflineMode } from "./driver-mode-repository.js";
import {
  assertMbtDriverBinProjectionScope,
  authorizeMbtDriverBinProjection
} from "./mbt/driver-bin-authorization.js";
import { applyMbtDriverBinOfflineEvent } from "./mbt/driver-bin-offline-application.js";
import {
  beginDriverOfflineReconciliationReceipt,
  completeDriverOfflineReconciliationReceipt,
  driverOfflineReconciliationDateSafety,
  getDriverOfflineReconciliationReceipt,
  markDriverOfflineReconciliationReceiptUncertain,
  releaseDriverOfflineReconciliationReceipt
} from "./driver-offline-reconciliation-repository.js";
import { createSamsaraDriverAuthToken, createSamsaraDriverVehicleAssignment, findSamsaraDriverByUsername, listSamsaraVehicleLocations, setSamsaraDriverDutyStatus, testSamsaraConnection } from "./samsara.js";
import { createPhotoReadToken, createPhotoUploadToken, isJpegEvidenceBytes, isR2PhotoReference, publicPhotoUploadConfig } from "./photo-upload.js";
import { getPhotoArchiveSettings, isPhotoArchiveRunning, photoArchiveAutoTick, readArchivedPhoto, recoverInterruptedPhotoArchive, runPhotoArchive, updatePhotoArchiveSettings } from "./photo-archive-repository.js";
import { authenticateDispatchDriver, ensureDispatchFleetSetup, getDispatchDriverByLogin, listDispatchDrivers, listDispatchTrucks, replaceDispatchFleetSetup, setDispatchDriverActive, setDispatchTruckActive, updateDispatchTruckCapabilities } from "./dispatch-setup-repository.js";
import { assertNoActiveConsolidationClaimsByRefs, confirmConsolidationItem, getActiveConsolidationBatch, getSavedConsolidationQueue, packConsolidationOrder, releaseConsolidationBatch, startSavedConsolidationBatch, updateConsolidationLine } from "./delivery-consolidation-repository.js";
import { DEPENDENCY_YARDS, assertNoActiveOrderDependenciesByRefs, cancelOrderDependency, completeDirectDependenciesForSalesOrderDrop, completeYardDependenciesForTransferDrop, confirmTransferDependencyBatch, createOrderDependency, enrichDispatchOrdersWithDependencies, generateTransferDependencySuggestion, getDependencyInventoryMatrix, getDirectPickupDependencyExecutionBlock, getOrderDependencyOptions, getSalesOrderDependencyExecutionBlock, getTransferDependencyBatch, listOrderDependencies, listTransferDependencyCandidates, markDirectDependencyPickupCompleted, mergeTransferDependencyProposals, normalDispatchGroupTargets, prepareTransferDependencyPalletItem, reconcileCompletedYardTransfersForSalesOrderStart, reconcileOrderDependency, removeTransferDependencyProposalLine, reopenTransferDependencyCandidate, retryTransferDependencyBatch, reviewTransferDependencyCandidate, syncDirectDependencyOperatorProgress, syncOrderDependenciesForTransferOrder, syncOrderDependenciesFromDispatchPlan, updateOrderDependencyMode, updateTransferDependencyBatch, validateDispatchPlanDependencies } from "./order-dependency-repository.js";
import { activateSmartScmInputFile, importSmartScmSalesCsv, listSmartScmInputFiles, parseSmartScmVendorResponseFile, smartScmInputDownload, storeSmartScmInputFile } from "./smart-scm-import-repository.js";
import { getSmartScmBootstrap, getSmartScmSettings, getSmartScmPlanningRun, listSmartScmForecasts, listSmartScmForecastRuns, listSmartScmPlanningPauses, listSmartScmPlanningRuns, listSmartScmProposals, promoteSmartScmForecastSegment, runSmartScmForecast, runSmartScmPlan, smartScmAutoTick, updateSmartScmSettings } from "./smart-scm-repository.js";
import { buildSmartScmItemMasterCsvTemplate, getSmartScmSyncStatus, importSmartScmItemMasterCsv, listSmartScmItems, updateSmartScmItem } from "./smart-scm-item-repository.js";
import { refreshSmartScmLiveData } from "./smart-scm-sync-service.js";
import { addSmartScmPlanningExclusion, deactivateSmartScmPlanningExclusion } from "./smart-scm-planning-exclusion-repository.js";
import {
  addSmartScmBlanketAlternativeLine,
  buildSmartScmBlanketPlan,
  cancelSmartScmBlanketReservation,
  cancelSmartScmBlanketReservationForProposal,
  confirmSmartScmBlanketProposal,
  finalizeSmartScmBlanketVendorWorkflow,
  listSmartScmBlanketWorkspace,
  removeSmartScmBlanketAlternativeLine,
  saveSmartScmBlanketVendorReplyDraft,
  searchSmartScmBlanketAlternatives,
  updateSmartScmBlanketProposalLine
} from "./smart-scm-blanket-repository.js";
import { completeSmartScmTransferExecution, failSmartScmTransferExecution, getSmartScmProposal, markSmartScmTransferAttention, prepareSmartScmTransferExecution, recordSmartScmVendorResponses, setSmartScmPalletQuantityOverride, updateSmartScmProposal } from "./smart-scm-planning-repository.js";
import { createSimplePdf, leaseYardPrintJob, listSmartScmPrintJobs, listYardPrinters, queueSmartScmPrintJob, queueYardPrinterTest, retrySmartScmPrintJob, rotateYardPrinterToken, updateLeasedPrintJob, updateYardPrinter, yardPrintJobDocument } from "./smart-scm-print-repository.js";
import { addSmartScmVendorAlternativeLine, listSmartScmNetSuitePoReviewLoads, removeSmartScmNetSuitePoReviewLoad, removeSmartScmVendorAlternativeLine, removeSmartScmVendorReplyLoad, saveSmartScmVendorReplyLoad, searchSmartScmVendorAlternatives, stageSmartScmVendorReplyLoad, updateSmartScmNetSuitePoReviewPalletQuantity } from "./smart-scm-vendor-repository.js";
import {
  getSmartScmVendorWorkflow,
  getSmartScmVendorWorkflowActionTarget,
  getSmartScmVendorWorkflowForProposal,
  findSmartScmVendorWorkflowByPurchaseOrder,
  ensureSmartScmVendorWorkflow,
  linkSmartScmVendorWorkflowReview,
  listSmartScmVendorWorkflowLoads,
  recordSmartScmVendorWorkflowAttention,
  recordSmartScmVendorWorkflowBlanketSplit,
  recordSmartScmVendorWorkflowPurchaseResult,
  saveSmartScmVendorEmailDraft
} from "./smart-scm-vendor-workflow-repository.js";
import { addSmartScmProposalLine, createSmartScmManualLoad, groupSmartScmProposals, recalculateSmartScmPoProposal, removeSmartScmProposalLine, searchSmartScmManualLoadItems, searchSmartScmProposalItems, splitSmartScmProposalLine, updateSmartScmProposalLine } from "./smart-scm-proposal-editor.js";
import { addTransferDependencyProposalLine, searchTransferDependencyProposalItems } from "./transfer-dependency-manual-items.js";
import { listSmartScmRouteRules, upsertSmartScmRouteRule } from "./smart-scm-route-repository.js";
import { dispatchLoadAssignment, normalizeDispatchPlanLoadAssignments, overlayLockedLoadDerivedSchedule, validateDispatchLoadAssignments } from "./dispatch-load-assignment.js";
import { dispatchLocationsShareYard } from "./dispatch-location.js";

import { executeSmartScmPurchaseProposal } from "./smart-scm-purchase-service.js";
import {
  findScmNetSuitePoHistoryByNetSuiteId,
  getScmNetSuitePoHistory,
  listScmNetSuitePoHistory,
  listScmNetSuitePoHistoryFilterOptions,
  setScmNetSuitePoHistoryArchived
} from "./scm-netsuite-po-history-repository.js";
import {
  getScmNetSuitePoHistoryPdf,
  processScmNetSuitePoHistoryWebhook,
  refreshScmNetSuitePoHistory,
  registerScmNetSuitePoHistoryCreation,
  updateScmNetSuitePoHistory
} from "./scm-netsuite-po-history-service.js";
import { SALES_YARDS, getSalesOrderPrintCandidate, getSalesOrderPrintSnapshot, listSalesOrderPrintCandidates, listSalesOrderPrintHistory, normalizeSalesYardLocationIds } from "./sales-repository.js";
import { getSalesPortalSettings, isPublicSalesAccessEnabled, updateSalesPortalSettings } from "./sales-settings-repository.js";
import { syncReturnCustomerDirectory } from "./return-customer-directory.js";
import {
  decideReturnLine,
  deleteReturnDraft,
  discardReturnDraftForControl,
  getReturnDraftForControl,
  getReturnReasons,
  getReturnRecordDetail,
  getReturnYardSettings,
  linkReturnNetSuiteTransaction,
  listReturnDrafts,
  listReturnDraftsForControl,
  listReturnRecords,
  listReturnYardSettings,
  lookupReturnCustomerPalletBalance,
  lookupReturnSalesOrder,
  processPendingReturnSyncs,
  reconcileReturnRecords,
  saveReturnDraft,
  searchReturnCustomers,
  submitReturnBatch,
  syncReturnRecord,
  updateReturnYardSettings,
  voidReturnRecord
} from "./return-repository.js";
const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const qrScannerDir = path.resolve(dirname, "../node_modules/qr-scanner");
const quaggaScannerDir = path.resolve(dirname, "../node_modules/@ericblade/quagga2/dist");
const dataDir = path.resolve(dirname, "../data");
const dispatchPlanPath = path.join(dataDir, "dispatch-plan.json");
const dispatchSetupPath = path.join(dataDir, "dispatch-setup.json");
const deliveryLocations = [1, 28, 15, 26];
const fulfillmentJobs = new Map();
const receivingJobs = new Map();
const eventClients = new Set();
const delayedTransactionStatusRefreshes = new Map();
const driverGeocodeCache = new Map();
const transferDependencyAllocationRefreshAt = new Map();
const DRIVER_GEOCODE_TIMEOUT_MS = 5_000;
let transferDependencyAllocationRefreshQueue = Promise.resolve();
let eventSeq = 0;

const defaultDispatchSetup = {
  drivers: [
    { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", ownYardFixedMinutes: 42, vendorFixedMinutes: 36, deliveryFixedMinutes: 36, outsideFixedMinutes: 36, minutesPerPallet: 1, loadMinutes: 42, unloadMinutes: 36 },
    { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", ownYardFixedMinutes: 38, vendorFixedMinutes: 32, deliveryFixedMinutes: 32, outsideFixedMinutes: 32, minutesPerPallet: 1, loadMinutes: 38, unloadMinutes: 32 }
  ],
  trucks: [
    { plate: "MBBS-101", capacityLbs: 48000, travelTimePercent: 0 },
    { plate: "MBBS-205", capacityLbs: 44000, travelTimePercent: 0 },
    { plate: "MBBS-318", capacityLbs: 52000, travelTimePercent: 0 }
  ],
  ownYards: [
    { code: "3445", name: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON", lat: 43.8204306, lng: -79.3053423 },
    { code: "2967", name: "2967", locationId: 28, address: "2967 Kennedy Road, Toronto, ON", lat: 43.806119, lng: -79.2986377 },
    { code: "12441", name: "12441", locationId: 15, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON", lat: 43.948694, lng: -79.3727582 },
    { code: "150", name: "150", locationId: 26, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" }
  ],
  sync: {
    mode: "manual",
    intervalSeconds: 60,
    maxRunSeconds: 900,
    running: false,
    lastStartedAt: "",
    lastFinishedAt: "",
    lastSource: "",
    lastStatus: "idle",
    lastError: ""
  },
  samsara: {
    dvirAuthorId: config.samsara.dvirAuthorId || ""
  },
  planning: {
    truckSwitchMinutes: 10
  }
};

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function sendLoadedOrdersCsv(req, res, {
  allowedYardLocationIds,
  allowedSalesStoreLocationIds
} = {}) {
  const rows = await listYardMovementCsvRows({
    from: req.query.from,
    to: req.query.to,
    yard: req.query.yard,
    search: req.query.search,
    itemSearch: req.query.itemSearch,
    direction: req.query.direction,
    orderType: req.query.orderType,
    allowedYardLocationIds,
    allowedSalesStoreLocationIds
  });
  const csv = [
    [
      "direction", "type", "order", "yard processed at", "last activity", "delivered at",
      "yard", "party", "driver record only", "driver", "truck", "yard photos", "driver photos",
      "item ID", "SKU", "item name", "description", "processed quantity", "UOM", "PLT", "LYR", "SEC", "PCS"
    ].map(csvCell).join(","),
    ...rows.map((row) => {
      const mixed = yardMixedUnits(row);
      const unitValues = Object.fromEntries(mixed.units.map((unit) => [unit.key, unit.value]));
      return [
        row.direction,
        row.order_type,
        row.order_ref,
        row.processed_at,
        row.last_activity_at,
        row.delivery_at,
        row.yard_location,
        row.party,
        row.driver_only ? "yes" : "no",
        row.driver_name,
        row.truck_plate,
        row.yard_photo_count,
        row.driver_photo_count,
        row.item_id,
        row.sku,
        row.item_name,
        row.item_description,
        row.processed_qty,
        row.processed_uom,
        unitValues.pallets || "",
        unitValues.layers || "",
        unitValues.sections || "",
        unitValues.pieces || ""
      ].map(csvCell).join(",");
    })
  ].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="in-outbound-record-${req.query.from || "from"}-${req.query.to || "to"}.csv"`);
  res.send(csv);
}

function orderTransactionType(orderRef, order = {}) {
  const type = order.type || (String(orderRef).startsWith("PO") ? "PO" : String(orderRef).startsWith("TO") ? "TO" : "SO");
  return {
    SO: "Sales Order",
    TO: "Transfer Order",
    PO: "Purchase Order",
    CUSTOM: "Custom Order"
  }[type] || "Sales Order";
}

function dispatchOperatorAssignmentMap(plan = {}) {
  const orderById = new Map((plan.orders || []).map((order) => [String(order?.id || ""), order]));
  const assignments = new Map();
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      const loadAssignment = dispatchLoadAssignment(truck, load);
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || !stop.orderId) continue;
        const order = orderById.get(String(stop.orderId || ""));
        if (!["SO", "TO"].includes(order?.type)) continue;
        const orderRef = String(order.id || stop.orderId || "");
        assignments.set(orderRef, [
          order.type,
          plan.planDate || "",
          loadAssignment.truckPlate,
          load.name || "",
          loadAssignment.parkingSpot
        ].join("|"));
      }
    }
  }
  return assignments;
}

function changedDispatchOperatorRefs(beforePlan = {}, afterPlan = {}) {
  const before = dispatchOperatorAssignmentMap(beforePlan);
  const after = dispatchOperatorAssignmentMap(afterPlan);
  const changed = [];
  for (const [orderRef, signature] of after.entries()) {
    if (before.get(orderRef) !== signature) changed.push(orderRef);
  }
  return changed;
}

function dispatchScmPlacementMap(plan = {}) {
  const orderById = new Map(
    (plan.orders || [])
      .filter((order) => ["PO", "TO"].includes(String(order?.type || "").toUpperCase()))
      .map((order) => [String(order.id || ""), order])
  );
  const placements = new Map();
  for (const [orderRef, order] of orderById) {
    placements.set(orderRef, {
      kind: String(order.type || "").toUpperCase(),
      order: {
        id: orderRef,
        sourceTable: order.sourceTable || "",
        sourceId: order.sourceId || "",
        pickup: order.pickup || order.pickupPoint || "",
        dropoff: order.dropoff || order.dropoffPoint || "",
        weight: order.weight || order.weightLbs || 0
      },
      stops: []
    });
  }
  for (const [truckIndex, truck] of (plan.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      for (const [stopIndex, stop] of (load.stops || []).entries()) {
        const ref = String(stop?.orderId || "");
        const placement = placements.get(ref);
        if (!placement) continue;
        placement.stops.push({
          truck: truck.id || truck.plate || truckIndex,
          load: load.id || load.name || loadIndex,
          stop: stopIndex,
          type: stop.type || "",
          location: stop.location || stop.address || ""
        });
      }
    }
  }
  return new Map([...placements].map(([ref, placement]) => [
    ref,
    JSON.stringify(placement)
  ]));
}

function changedDispatchScmRefs(beforePlan = {}, afterPlan = {}) {
  const before = dispatchScmPlacementMap(beforePlan);
  const after = dispatchScmPlacementMap(afterPlan);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => before.get(ref) !== after.get(ref));
}

function dispatchPlacedScmRefs(plan = {}) {
  const scmKindsByRef = new Map(
    (plan.orders || [])
      .filter((order) => ["PO", "TO"].includes(String(order?.type || "").toUpperCase()))
      .map((order) => [String(order.id || ""), String(order.type || "").toUpperCase()])
  );
  const refs = new Set();
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        const orderRef = String(stop?.orderId || "");
        if (scmKindsByRef.has(orderRef)) refs.add(orderRef);
      }
    }
  }
  return [...refs];
}

async function assertNoRestrictedScmDispatchOrders(orderRefs = [], action = "plan") {
  const requestedRefs = [...new Set((orderRefs || [])
    .map((ref) => String(ref || "").trim())
    .filter(Boolean))];
  if (!requestedRefs.length) return;
  const restrictedRefs = await listRestrictedScmDispatchOrderRefs();
  const conflicts = requestedRefs
    .filter((ref) => restrictedRefs.has(ref.toLowerCase()))
    .map((orderRef) => ({
      orderRef,
      reason: `${orderRef} is Blanket, Hold, Complete, or Cancelled and cannot be added to Dispatch.`
    }));
  if (!conflicts.length) return;
  throw Object.assign(
    new Error(`Remove restricted PO/TO orders before you ${action}: ${conflicts.map((item) => item.orderRef).join(", ")}.`),
    {
      status: 409,
      code: "DISPATCH_RESTRICTED_SCM_ORDER",
      conflicts
    }
  );
}

function dispatchOperatorImpactSignature(plan = {}) {
  const assignmentEntries = [...dispatchOperatorAssignmentMap(plan).entries()].sort(([a], [b]) => a.localeCompare(b));
  const operatorOrders = (plan.orders || [])
    .filter((order) => ["SO", "TO", "CO"].includes(order?.type) || order?.originalOrderId || order?.transitCo)
    .map((order) => ({
      id: order.id || "",
      type: order.type || "",
      originalOrderId: order.originalOrderId || "",
      sourceYard: order.sourceYard || "",
      destinationYard: order.destinationYard || "",
      pickupLocations: order.pickupLocations || [],
      transitCo: order.transitCo
        ? {
            id: order.transitCo.id || "",
            fromYard: order.transitCo.fromYard || "",
            toYard: order.transitCo.toYard || ""
          }
        : null,
      childOrders: order.childOrders || [],
      items: (order.items || []).map((item) => ({
        id: item.id || item.lineRowId || item.lineId || item.sku || item.itemName || "",
        sku: item.sku || item.itemName || "",
        quantity: item.quantity ?? item.salesQty ?? "",
        pallets: item.pallets ?? item.pallet_qty ?? "",
        layers: item.layers ?? item.layer_qty ?? "",
        sections: item.sections ?? item.section_qty ?? "",
        pieces: item.pieces ?? item.piece_qty ?? "",
        splitQty: item.splitQty ?? "",
        splitParts: item.splitParts || null
      }))
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({
    planDate: plan.planDate || "",
    assignments: assignmentEntries,
    orders: operatorOrders
  });
}

function dispatchOperatorImpactChanged(beforePlan = {}, afterPlan = {}) {
  return dispatchOperatorImpactSignature(beforePlan || {}) !== dispatchOperatorImpactSignature(afterPlan || {});
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((memo, key) => {
      memo[key] = stableJsonValue(value[key]);
      return memo;
    }, {});
}

function dispatchPlanDataSignature({ orders = [], trucks = [] } = {}) {
  return JSON.stringify(stableJsonValue({ orders, trucks }));
}

function dispatchPlanDataChanged(previousPlan = {}, nextPlan = {}) {
  return dispatchPlanDataSignature(previousPlan || {}) !== dispatchPlanDataSignature(nextPlan || {});
}

function dispatchBinConfirmComparisonValue(plan = {}) {
  const value = structuredClone({
    orders: Array.isArray(plan?.orders) ? plan.orders : [],
    trucks: Array.isArray(plan?.trucks) ? plan.trucks : []
  });
  for (const truck of value.trucks) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      for (const stop of Array.isArray(load?.stops) ? load.stops : []) {
        if (!stop?.mbt || typeof stop.mbt !== "object" || Array.isArray(stop.mbt)) continue;
        delete stop.loadId;
        delete stop.timing;
      }
    }
  }
  return value;
}

function dispatchConfirmPlanDataChanged(previousPlan = {}, nextPlan = {}) {
  const previousHasBin = binDispatchOrders(previousPlan).length > 0;
  const nextHasBin = binDispatchOrders(nextPlan).length > 0;
  if (!previousHasBin || !nextHasBin) {
    return dispatchPlanDataChanged(previousPlan, nextPlan);
  }
  return dispatchPlanDataSignature(dispatchBinConfirmComparisonValue(previousPlan))
    !== dispatchPlanDataSignature(dispatchBinConfirmComparisonValue(nextPlan));
}

function dispatchPlanSaveMode(body = {}) {
  return String(body?.saveMode || body?.audit?.details?.saveMode || "").trim();
}

function dispatchTruckDriverKey(truck = {}) {
  const key = String(truck.driverLogin || truck.driver_login || truck.driver || "").trim().toLowerCase();
  return key && key !== "unassigned" ? key : "";
}

function dispatchDuplicateDriverAssignments(trucks = []) {
  const seen = new Map();
  const duplicates = [];
  for (const truck of trucks || []) {
    const key = dispatchTruckDriverKey(truck);
    if (!key) continue;
    const assignment = {
      driver: truck.driver || truck.driverLogin || key,
      driverLogin: truck.driverLogin || truck.driver_login || "",
      truckId: truck.id || "",
      truckPlate: truck.plate || ""
    };
    if (seen.has(key)) {
      duplicates.push({ driverKey: key, trucks: [seen.get(key), assignment] });
      continue;
    }
    seen.set(key, assignment);
  }
  return duplicates;
}

function sendDispatchDuplicateDriverResponse(res, duplicates = []) {
  const preview = duplicates
    .slice(0, 3)
    .map((item) => `${item.driverKey}: ${item.trucks.map((truck) => truck.truckPlate || truck.truckId).filter(Boolean).join(", ")}`)
    .join("; ");
  res.status(409).json({
    code: "DISPATCH_DRIVER_DUPLICATE",
    error: `One driver can only be assigned to one truck${preview ? `: ${preview}` : "."}`,
    duplicates
  });
}

function dispatchDriverActivityLockedLoadIds(statuses = []) {
  return new Set((statuses || [])
    .filter((status) => ["in_progress", "complete"].includes(String(status.status || "")))
    .map((status) => String(status.load_id || status.loadId || ""))
    .filter(Boolean));
}

async function overlayDispatchLockedLoadSchedule(previousPlan = {}, nextPlan = {}) {
  if (!config.dispatch?.driverOrientedPlanning || !previousPlan?.id) return nextPlan;
  const statuses = await listDriverJobStatuses({ planId: previousPlan.id });
  return overlayLockedLoadDerivedSchedule(
    previousPlan,
    nextPlan,
    dispatchDriverActivityLockedLoadIds(statuses),
    { activityStatuses: statuses }
  );
}

async function dispatchLoadAssignmentConflicts(previousPlan = {}, nextPlan = {}, { requireAssignments = false } = {}) {
  if (!config.dispatch?.driverOrientedPlanning) return [];
  const setup = await readDispatchSetup({ includeInactive: true });
  const normalized = normalizeDispatchPlanLoadAssignments(nextPlan);
  let statuses = [];
  let allowedInactiveLoadIds = new Set();
  if (previousPlan?.id) {
    statuses = await listDriverJobStatuses({ planId: previousPlan.id });
    const completed = await query(
      `SELECT load_id
         FROM dispatch_plan_load_assignments
        WHERE plan_id = $1
          AND completed = true`,
      [previousPlan.id]
    );
    allowedInactiveLoadIds = unchangedCompletedDispatchLoadIds(
      previousPlan,
      normalized,
      completed.rows.map((row) => row.load_id)
    );
  }
  const conflicts = validateDispatchLoadAssignments(normalized, {
    switchMinutes: setup.planning?.truckSwitchMinutes ?? 10,
    ownYards: (setup.ownYards || []).map((yard) => String(yard.code || yard.name || "")).filter(Boolean),
    requireAssignments,
    previousPlan,
    activityStatuses: statuses
  });
  conflicts.push(...dispatchFleetAssignmentStatusConflicts(normalized, {
    drivers: setup.drivers,
    trucks: setup.trucks
  }, {
    allowedInactiveLoadIds
  }));
  if (!previousPlan?.id) return conflicts;
  const executionPolicy = evaluateExecutedPrefixPolicy({
    previousPlan,
    nextPlan: normalized,
    activity: statuses
  });
  conflicts.push(...executionPolicy.conflicts);
  return conflicts;
}

async function dispatchPlanSummaryWithSetup(summary = {}) {
  const setup = await readDispatchSetup();
  return {
    ...(summary || {}),
    ownYardCodes: [...new Set((setup.ownYards || [])
      .map((yard) => String(yard?.code || yard?.name || yard?.id || "").trim())
      .filter(Boolean))]
  };
}

function sendDispatchLoadAssignmentConflictResponse(res, conflicts = []) {
  const first = conflicts[0] || {};
  return res.status(409).json({
    code: first.code || "DISPATCH_DRIVER_TIME_CONFLICT",
    error: first.message || "Driver or truck assignment is invalid.",
    conflicts
  });
}

function dispatchTruckSequenceKey(truck = {}) {
  return String(truck.id || truck.plate || "").trim();
}

function mergeDispatchTruckSequence(latestTrucks = [], requestedTrucks = []) {
  const latestByKey = new Map((latestTrucks || [])
    .map((truck) => [dispatchTruckSequenceKey(truck), truck])
    .filter(([key]) => key));
  const requestedByKey = new Map((requestedTrucks || [])
    .map((truck) => [dispatchTruckSequenceKey(truck), truck])
    .filter(([key]) => key));
  const seen = new Set();
  const merged = [];
  for (const requested of requestedTrucks || []) {
    const key = dispatchTruckSequenceKey(requested);
    if (!key || seen.has(key)) continue;
    merged.push(latestByKey.get(key) || requested);
    seen.add(key);
  }
  for (const latest of latestTrucks || []) {
    const key = dispatchTruckSequenceKey(latest);
    if (!key || seen.has(key)) continue;
    merged.push(latest);
    seen.add(key);
  }
  for (const requested of requestedTrucks || []) {
    const key = dispatchTruckSequenceKey(requested);
    if (!key || seen.has(key) || latestByKey.has(key)) continue;
    merged.push(requestedByKey.get(key) || requested);
    seen.add(key);
  }
  return merged;
}

async function dispatchPlannedAssignmentsFromSnapshots() {
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
      ORDER BY p.plan_date DESC, p.updated_at DESC`
  );
  const assignments = new Map();
  for (const row of result.rows) {
    const planAssignments = dispatchPlannedAssignmentMap({
      id: row.id,
      planDate: row.plan_date,
      orders: row.orders || [],
      trucks: row.trucks || []
    });
    for (const [ref, details] of planAssignments.entries()) {
      if (!assignments.has(ref)) assignments.set(ref, details);
    }
  }
  await removeStaleCoPlannedAssignments(assignments);
  return assignments;
}

async function removeStaleCoPlannedAssignments(assignments) {
  const coRefs = [...assignments.keys()].filter((ref) => String(ref || "").startsWith("CO-"));
  if (!coRefs.length) return;
  const result = await query(
    `SELECT co_ref,
            dispatch_plan_id::text AS dispatch_plan_id,
            dispatch_plan_date::date::text AS dispatch_plan_date
       FROM co_orders
      WHERE co_ref = ANY($1)`,
    [coRefs]
  );
  const activeCo = new Map(result.rows.map((row) => [String(row.co_ref || ""), row]));
  for (const coRef of coRefs) {
    const row = activeCo.get(coRef);
    const details = assignments.get(coRef);
    const rowPlanId = String(row?.dispatch_plan_id || "");
    const rowPlanDate = String(row?.dispatch_plan_date || "").slice(0, 10);
    const assignmentPlanId = String(details?.dispatchPlanId || "");
    const assignmentPlanDate = String(details?.dispatchPlanDate || "").slice(0, 10);
    const matchesPlanId = rowPlanId && assignmentPlanId && rowPlanId === assignmentPlanId;
    const matchesPlanDate = rowPlanDate && assignmentPlanDate && rowPlanDate === assignmentPlanDate;
    if (!row || (!matchesPlanId && !matchesPlanDate)) assignments.delete(coRef);
  }
}

async function enrichDispatchOrdersWithPlanAssignments(orders = []) {
  const plannedAssignments = await dispatchPlannedAssignmentsFromSnapshots();
  return (orders || []).map((order) => {
    const planned = plannedAssignments.get(String(order.id || ""));
    return applyDispatchPlannedAssignment(order, planned || null);
  });
}

async function listDispatchPlannedAssignments() {
  const plannedAssignments = await dispatchPlannedAssignmentsFromSnapshots();
  return [...plannedAssignments.entries()]
    .map(([orderRef, details]) => ({ orderRef, ...details }))
    .sort((a, b) => String(a.orderRef).localeCompare(String(b.orderRef)));
}

async function dispatchCustomOrderActivityMap(customOrders = []) {
  const refs = [...new Set(
    (customOrders || []).map((order) => String(order?.refNumber || "").trim().toLowerCase()).filter(Boolean)
  )];
  if (!refs.length) return new Map();
  const result = await query(
    `SELECT lower(btrim(ref.order_ref)) AS ref_key,
            BOOL_OR(r.status = 'complete' AND r.stop_type = 'dropoff') AS completed_dropoff,
            BOOL_OR(r.status IN ('in_progress', 'complete')) AS has_activity,
            MAX(COALESCE(r.completed_at, r.started_at, r.created_at)) AS last_activity_at,
            (ARRAY_AGG(r.driver_login ORDER BY COALESCE(r.completed_at, r.started_at, r.created_at) DESC, r.id DESC))[1] AS driver_login,
            (ARRAY_AGG(r.truck_plate ORDER BY COALESCE(r.completed_at, r.started_at, r.created_at) DESC, r.id DESC))[1] AS truck_plate
       FROM driver_job_records r
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE
           WHEN jsonb_typeof(COALESCE(r.order_refs, '[]'::jsonb)) = 'array'
             THEN COALESCE(r.order_refs, '[]'::jsonb)
           ELSE '[]'::jsonb
         END
       ) ref(order_ref)
      WHERE lower(btrim(ref.order_ref)) = ANY($1::text[])
        AND r.status IN ('in_progress', 'complete')
      GROUP BY lower(btrim(ref.order_ref))`,
    [refs]
  );
  return new Map(result.rows.map((row) => [row.ref_key, row]));
}

async function dispatchCustomOrdersForManagement({ includeCancelled = true, search = "" } = {}) {
  const customOrders = await listDispatchCustomOrders({
    includeCancelled,
    includeCompleted: true,
    search
  });
  const [assignments, activityByRef] = await Promise.all([
    dispatchPlannedAssignmentsFromSnapshots(),
    dispatchCustomOrderActivityMap(customOrders)
  ]);
  return customOrders.map((order) => {
    const assignment = assignments.get(String(order.refNumber || "")) || null;
    const activity = activityByRef.get(String(order.refNumber || "").trim().toLowerCase()) || null;
    const completed = order.status === "completed" || Boolean(activity?.completed_dropoff);
    const planned = Boolean(assignment);
    const locked = order.status !== "open" || planned || Boolean(activity?.has_activity);
    const status = order.status === "cancelled"
      ? "cancelled"
      : completed
        ? "completed"
        : planned || activity?.has_activity
          ? "planned"
          : "open";
    const lockedReason = order.status === "cancelled"
      ? "Cancelled Custom Orders are read-only."
      : completed
        ? "This Custom Order has been delivered and is read-only."
        : activity?.has_activity
          ? "Driver activity has started. This Custom Order can no longer be changed."
          : planned
            ? `Remove this Custom Order from ${assignment.dispatchPlanDate || "its dispatch plan"} before editing or cancelling it.`
            : "";
    return {
      ...order,
      status,
      storageStatus: order.status,
      planned,
      planId: assignment?.dispatchPlanId || "",
      planDate: assignment?.dispatchPlanDate || "",
      truckPlate: assignment?.dispatchTruckPlate || activity?.truck_plate || "",
      loadName: assignment?.dispatchLoadName || "",
      parkingSpot: assignment?.dispatchParkingSpot || "",
      driverLogin: assignment?.dispatchDriverLogin || activity?.driver_login || "",
      driverName: assignment?.dispatchDriverName || activity?.driver_login || "",
      driverActivity: Boolean(activity?.has_activity),
      lastActivityAt: activity?.last_activity_at || null,
      editable: !locked,
      canCancel: !locked,
      lockedReason
    };
  });
}

async function assertDispatchCustomOrderMutable(order) {
  if (!order) return;
  if (order.status !== "open") {
    throw Object.assign(new Error(
      order.status === "completed"
        ? "This Custom Order has already been delivered and cannot be changed."
        : "Cancelled Custom Orders cannot be changed."
    ), { status: 409, code: "DISPATCH_CUSTOM_ORDER_NOT_EDITABLE" });
  }
  const assignments = await dispatchPlannedAssignmentsFromSnapshots();
  const assignment = assignments.get(String(order.refNumber || ""));
  if (assignment) {
    throw Object.assign(new Error(
      `Remove ${order.refNumber} from the ${assignment.dispatchPlanDate || "current"} dispatch plan before editing or cancelling it.`
    ), {
      status: 409,
      code: "DISPATCH_CUSTOM_ORDER_PLANNED",
      assignment
    });
  }
  const activity = await dispatchCustomOrderActivityMap([order]);
  if (activity.get(String(order.refNumber || "").trim().toLowerCase())?.has_activity) {
    throw Object.assign(new Error(
      `Driver activity has started for ${order.refNumber}. It can no longer be edited or cancelled.`
    ), { status: 409, code: "DISPATCH_CUSTOM_ORDER_DRIVER_ACTIVITY" });
  }
}

async function assertNoSnapshotDispatchRefCollision(refNumber) {
  const refKey = String(refNumber || "").trim().toLowerCase();
  if (!refKey) return;
  const snapshotOrders = await listDispatchSnapshotDerivedOrders();
  const collision = snapshotOrders.find((order) => String(order?.id || "").trim().toLowerCase() === refKey);
  if (!collision) return;
  throw Object.assign(new Error(
    `Reference ${refNumber} is already used by dispatch order ${collision.id}. Choose a unique reference number.`
  ), { status: 409, code: "DISPATCH_CUSTOM_ORDER_REF_EXISTS" });
}

function isSnapshotDerivedDispatchOrder(order = {}) {
  if (!order?.id || order?.type === "CO") return false;
  return Boolean(
    (Array.isArray(order.childOrders) && order.childOrders.length)
    || String(order.originalOrderId || "").trim()
  );
}

async function listRestrictedScmDispatchOrderRefs() {
  const result = await query(
    `WITH restricted_rows AS (
       SELECT s.order_ref,
              s.display_ref,
              s.group_ref
         FROM scm_transport_schedule s
        WHERE LOWER(BTRIM(COALESCE(s.status, 'Queued'))) IN (
          'hold', 'complete', 'completed', 'cancelled', 'canceled'
        )
       UNION ALL
       SELECT po.tranid AS order_ref,
              po.dispatch_ref AS display_ref,
              NULL::text AS group_ref
         FROM purchase_orders po
        WHERE po.is_blanket_po = true
           OR (
             LOWER(BTRIM(COALESCE(po.initial_scm_status, 'Queued'))) IN (
               'hold', 'complete', 'completed', 'cancelled', 'canceled'
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM scm_transport_schedule current_schedule
                WHERE current_schedule.order_kind = 'PO'
                  AND (
                    current_schedule.source_id = po.netsuite_id
                    OR LOWER(BTRIM(current_schedule.order_ref)) = LOWER(BTRIM(po.tranid))
                    OR LOWER(BTRIM(current_schedule.order_ref)) = LOWER(BTRIM(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)))
                    OR LOWER(BTRIM(COALESCE(current_schedule.display_ref, ''))) = LOWER(BTRIM(po.tranid))
                    OR LOWER(BTRIM(COALESCE(current_schedule.display_ref, ''))) = LOWER(BTRIM(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)))
                  )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM scm_reconciliation_order_state current_state
                WHERE current_state.order_kind = 'PO'
                  AND (
                    current_state.source_order_netsuite_id = po.netsuite_id
                    OR LOWER(BTRIM(current_state.source_order_ref)) = LOWER(BTRIM(po.tranid))
                  )
                  AND current_state.reconciliation_status IS DISTINCT FROM 'pending'
                  AND COALESCE(BTRIM(current_state.application_status), '') <> ''
             )
           )
       UNION ALL
       SELECT state.source_order_ref AS order_ref,
              NULL::text AS display_ref,
              NULL::text AS group_ref
         FROM scm_reconciliation_order_state state
        WHERE LOWER(BTRIM(COALESCE(state.application_status, 'Queued'))) IN (
          'hold', 'complete', 'completed', 'cancelled', 'canceled'
        )
       UNION ALL
       SELECT target.target_ref AS order_ref,
              NULL::text AS display_ref,
              NULL::text AS group_ref
         FROM scm_reconciliation_order_state state
         CROSS JOIN LATERAL JSONB_EACH(
           CASE
             WHEN JSONB_TYPEOF(state.quantity_summary->'targets') = 'object'
               THEN state.quantity_summary->'targets'
             ELSE '{}'::jsonb
           END
         ) target(target_ref, target_state)
        WHERE LOWER(BTRIM(COALESCE(target.target_state->>'applicationStatus', 'Queued'))) IN (
          'hold', 'complete', 'completed', 'cancelled', 'canceled'
        )
     )
     SELECT DISTINCT LOWER(BTRIM(ref.value)) AS order_ref
       FROM restricted_rows restricted_row
       CROSS JOIN LATERAL UNNEST(ARRAY[
         restricted_row.order_ref,
         restricted_row.display_ref,
         restricted_row.group_ref
       ]) ref(value)
      WHERE COALESCE(BTRIM(ref.value), '') <> ''`
  );
  return new Set(result.rows.map((row) => String(row.order_ref || "").trim()).filter(Boolean));
}

function dispatchOrderLogicalRefs(order = {}) {
  return [
    order.id,
    order.dispatchRef,
    order.originalPoRef,
    order.originalOrderId,
    order.sourceOrderId,
    order.scm?.groupRef,
    ...(Array.isArray(order.childOrders) ? order.childOrders : []),
    ...(Array.isArray(order.groupAliases) ? order.groupAliases : []),
    ...(Array.isArray(order.childOrderDetails)
      ? order.childOrderDetails.flatMap((child) => [child?.id, child?.originalOrderId])
      : [])
  ]
    .map((ref) => String(ref || "").trim().toLowerCase())
    .filter(Boolean);
}

async function listDispatchSnapshotDerivedOrders({ type = null, search = "" } = {}) {
  const sandbox = isNetSuiteSandboxEnvironment();
  const snapshotSearch = String(search || "").trim().slice(0, 120);
  const [result, inactiveSplits, blanketPurchaseOrders] = await Promise.all([
    query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.updated_at, s.orders
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
        AND ($1::text = '' OR s.orders::text ILIKE ('%' || $1 || '%'))
      ORDER BY p.updated_at DESC, p.plan_date DESC`,
      [snapshotSearch]
    ),
    query(
      `SELECT tranid FROM sales_orders WHERE tranid LIKE '%-S%' AND netsuite_active = false
       UNION
       SELECT tranid FROM transfer_orders WHERE tranid LIKE '%-S%' AND netsuite_active = false`
    ),
    query(
      `SELECT tranid, dispatch_ref
         FROM purchase_orders
        WHERE is_blanket_po = true`
    )
  ]);
  const inactiveSplitRefs = new Set(inactiveSplits.rows.map((row) => String(row.tranid || "")));
  const blanketPurchaseOrderRefs = new Set(blanketPurchaseOrders.rows.flatMap((row) => [row.tranid, row.dispatch_ref])
    .map((ref) => String(ref || "").trim().toLowerCase())
    .filter(Boolean));
  const derivedOrders = new Map();
  const wantedType = type ? String(type).toUpperCase() : "";
  for (const row of result.rows) {
    for (const order of row.orders || []) {
      if (!isSnapshotDerivedDispatchOrder(order)) continue;
      if (wantedType && String(order?.type || "").toUpperCase() !== wantedType) continue;
      const id = String(order?.id || "").trim();
      if (String(order?.type || "").toUpperCase() === "PO" && blanketPurchaseOrderRefs.has(id.toLowerCase())) continue;
      const fixtureRefs = [id, order?.originalOrderId, ...(Array.isArray(order?.childOrders) ? order.childOrders : [])]
        .map((value) => String(value || "").trim());
      if (!sandbox && fixtureRefs.some((value) => /^TSTDEP-SO-/i.test(value))) continue;
      if (String(order?.originalOrderId || "").trim() && inactiveSplitRefs.has(id)) continue;
      if (!id || derivedOrders.has(id)) continue;
      derivedOrders.set(id, {
        ...order,
        testFixture: sandbox && fixtureRefs.some((value) => /^TSTDEP-SO-/i.test(value)),
        childOrders: Array.isArray(order.childOrders) ? order.childOrders.filter(Boolean) : [],
        dispatchSnapshotSourcePlanId: String(row.id || ""),
        dispatchSnapshotSourcePlanDate: String(row.plan_date || "").slice(0, 10)
      });
    }
  }
  return [...derivedOrders.values()];
}

function mergeDispatchOrderFeedWithSnapshotDerivedOrders(orders = [], derivedOrders = []) {
  const byId = new Map((orders || []).map((order) => [String(order?.id || ""), order]));
  for (const derived of derivedOrders || []) {
    const id = String(derived?.id || "").trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, derived);
  }
  return [...byId.values()];
}

function dispatchOrderMatchesSearch(order = {}, search = "") {
  const term = String(search || "").trim().toLowerCase();
  if (!term) return true;
  return [
    order.id,
    order.type,
    order.dispatchRef,
    order.originalPoRef,
    order.customer,
    order.address,
    order.sourceYard,
    order.destinationYard,
    order.sourceOrderId,
    order.relatedSoId,
    order.transitCo?.id,
    order.expectedDeliveryDate,
    order.notes,
    ...(order.childOrders || []),
    ...(order.groupAliases || []),
    ...(order.childOrderDetails || []).flatMap((child) => [child?.id, child?.originalOrderId]),
    ...(order.items || []).flatMap((item) => [item.sku, item.itemName, item.description])
  ].join(" ").toLowerCase().includes(term);
}

async function listDispatchOrdersForResponse({ type = null, search = "" } = {}) {
  const searchTerm = String(search || "").trim().slice(0, 120);
  const requestedType = String(type || "").trim().toUpperCase();
  const includeCustom = !requestedType || requestedType === "TO" || requestedType === "CUSTOM";
  const [orders, customOrders, snapshotOrders, restrictedScmRefs, billedSalesOrders] = await Promise.all([
    listDispatchOrders({ type, search: searchTerm }),
    includeCustom
      ? listDispatchCustomOrders({
          includeCancelled: false,
          includeCompleted: false,
          search: searchTerm
        })
      : Promise.resolve([]),
    listDispatchSnapshotDerivedOrders({ type, search: searchTerm }),
    listRestrictedScmDispatchOrderRefs(),
    listBilledSalesOrderFamilyRefs()
  ]);
  const billedSalesOrderRefs = new Set(billedSalesOrders.flatMap((order) => [order.ref, order.id])
    .map((ref) => String(ref || "").trim().toLowerCase())
    .filter(Boolean));
  const isBilledSalesOrderFamily = (order) => {
    const type = String(order?.type || "").trim().toUpperCase();
    if (type !== "SO" && !Array.isArray(order?.childOrders)) return false;
    return dispatchOrderLogicalRefs(order).some((ref) => billedSalesOrderRefs.has(ref));
  };
  const currentOrders = filterRestrictedScmOrders([
    ...orders,
    ...customOrders.map(dispatchOrderFromCustomOrder)
  ], { includeRestricted: false }).filter((order) => !isBilledSalesOrderFamily(order)).filter((order) => {
    if (!["PO", "TO", "VRMA"].includes(String(order?.type || "").trim().toUpperCase())) return true;
    return !dispatchOrderLogicalRefs(order).some((ref) => restrictedScmRefs.has(ref));
  });
  const derivedCandidates = searchTerm
    ? snapshotOrders.filter((order) => dispatchOrderMatchesSearch(order, searchTerm))
    : snapshotOrders;
  const derivedOrders = filterRestrictedScmOrders(derivedCandidates, {
    includeRestricted: false
  }).filter((order) => !isBilledSalesOrderFamily(order)).filter((order) => {
    if (!["PO", "TO", "VRMA"].includes(String(order?.type || "").trim().toUpperCase())) return true;
    return !dispatchOrderLogicalRefs(order).some((ref) => restrictedScmRefs.has(ref));
  });
  const assigned = await enrichDispatchOrdersWithPlanAssignments(mergeDispatchOrderFeedWithSnapshotDerivedOrders(currentOrders, derivedOrders));
  const poLinked = await enrichDispatchOrdersWithPoTargetAllocations(assigned);
  const enriched = await enrichDispatchOrdersWithDependencies(poLinked);
  const reconciliationRows = await enrichScmScheduleWithReconciliation(
    enriched
      .filter((order) => ["PO", "TO"].includes(String(order?.type || "").toUpperCase()))
      .map((order) => ({
        orderKind: String(order.type).toUpperCase(),
        orderRef: order.id,
        sourceRef: order.originalPoRef || order.originalOrderId || order.id,
        sourceId: order.netsuiteId || order.sourceId || order.raw?.netsuite_id || null,
        status: order.scm?.status || "Queued"
      })),
    { includeDetails: false, view: "dispatch" }
  );
  const reconciliationByRef = new Map(reconciliationRows.map((row) => [
    `${row.orderKind}:${String(row.orderRef || "").toLowerCase()}`,
    row
  ]));
  const withReconciliation = enriched.map((order) => {
    const row = reconciliationByRef.get(
      `${String(order.type || "").toUpperCase()}:${String(order.id || "").toLowerCase()}`
    );
    if (!row) return order;
    return {
      ...order,
      reconciliationStatus: row.reconciliationStatus || "",
      reconciliationReason: row.reconciliationReason || "",
      reconciliationBlocked: String(row.reconciliationStatus || "").toLowerCase() === "review",
      scm: {
        ...(order.scm || {}),
        status: row.status || order.scm?.status || "",
        reconciliationApplicationStatus: row.reconciliationApplicationStatus || "",
        reconciliationStatus: row.reconciliationStatus || "",
        reconciliationReason: row.reconciliationReason || ""
      }
    };
  });
  const visibleOrders = filterRestrictedScmOrders(withReconciliation, {
    includeRestricted: false
  }).filter((order) => !isBilledSalesOrderFamily(order)).filter((order) => {
    if (!["PO", "TO", "VRMA"].includes(String(order?.type || "").trim().toUpperCase())) return true;
    return !dispatchOrderLogicalRefs(order).some((ref) => restrictedScmRefs.has(ref));
  });
  return searchTerm
    ? visibleOrders.filter((order) => dispatchOrderMatchesSearch(order, searchTerm))
    : visibleOrders;
}

async function targetedDispatchMutationOrders(orderRefs = []) {
  const refs = [...new Set((orderRefs || [])
    .map((ref) => String(ref || "").trim().toLowerCase())
    .filter(Boolean))];
  if (!refs.length) return [];
  const feeds = await Promise.all(refs.map((search) => listDispatchOrdersForResponse({ search })));
  const byId = new Map();
  for (const feed of feeds) {
    for (const order of feed || []) {
      if (!dispatchOrderLogicalRefs(order).some((ref) => refs.includes(ref))) continue;
      const key = String(order?.id || "").trim().toLowerCase();
      if (key && !byId.has(key)) byId.set(key, order);
    }
  }
  return [...byId.values()];
}

async function dispatchMutationOrderResponse(req, orderRefs = [], { legacyType = null } = {}) {
  if (req.query?.response === "targeted") {
    dispatchPrivateNoStore(req.res);
    return { orders: await targetedDispatchMutationOrders(orderRefs) };
  }
  return { orders: await listDispatchOrdersForResponse({ type: legacyType }) };
}

async function listScmPurchaseOrdersForResponse(filters = {}, operator = null) {
  const orders = await listScmPurchaseOrders(filters);
  const reconciliationRows = await enrichScmScheduleWithReconciliation(
    orders.map((order) => ({
      orderKind: "PO",
      orderRef: order.id,
      sourceRef: order.sourcePoRef || order.originalPoRef || order.dispatchRef || order.id,
      sourceId: order.netsuiteId || order.sourceId || order.raw?.netsuite_id || null,
      status: order.scm?.status || "Hold",
      scheduleId: order.scm?.scheduleId || null,
      updatedAt: order.scm?.updatedAt || null
    })),
    { includeDetails: false, view: "dispatch" }
  );
  const reconciliationByRef = new Map(reconciliationRows.map((row) => [
    String(row.orderRef || "").toLowerCase(),
    row
  ]));
  const reconciled = orders.map((order) => {
    const row = reconciliationByRef.get(String(order.id || "").toLowerCase());
    if (!row) return order;
    return {
      ...order,
      reconciliationStatus: row.reconciliationStatus || "",
      reconciliationReason: row.reconciliationReason || "",
      reconciliationBlocked: String(row.reconciliationStatus || "").toLowerCase() === "review",
      lastReconciledAt: row.lastReconciledAt || null,
      scm: {
        ...(order.scm || {}),
        status: row.status || order.scm?.status || "",
        reconciliationApplicationStatus: row.reconciliationApplicationStatus || "",
        reconciliationStatus: row.reconciliationStatus || "",
        reconciliationReason: row.reconciliationReason || ""
      }
    };
  });
  return filterRestrictedScmOrders(reconciled, {
    includeRestricted: canViewRestrictedScmOrders(operator)
  });
}

function sendDispatchDependencyConflictResponse(res, conflicts = []) {
  return res.status(409).json({
    error: conflicts[0] || "Order dependency timing is invalid.",
    code: "DISPATCH_ORDER_DEPENDENCY_CONFLICT",
    conflicts
  });
}

async function transferDependencyRestPayload({ proposal, batch }) {
  const locations = await resolveNetSuiteTransferLocations({
    sourceLocationId: proposal.fromLocationId,
    sourceLocation: proposal.fromLocation,
    destinationLocationId: proposal.toLocationId,
    destinationLocation: proposal.toLocation
  });
  return {
    payload: buildTransferDependencyRestPayload({ proposal, batch, locations }),
    intercompany: locations.intercompany,
    locations
  };
}

const TRANSFER_DEPENDENCY_ALLOCATION_TTL_MS = 60 * 1000;

async function transferDependencyAllocationOrderIds(salesOrderId = null) {
  const requestedId = Number(salesOrderId);
  if (salesOrderId !== null && salesOrderId !== undefined && (!Number.isSafeInteger(requestedId) || requestedId <= 0)) {
    throw Object.assign(new Error("A valid Sales Order ID is required."), { status: 400 });
  }
  const result = await query(
    `SELECT DISTINCT o.netsuite_id
       FROM sales_orders o
       JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
      WHERE o.netsuite_id > 0
        AND COALESCE(o.netsuite_active, true) = true
        AND COALESCE(l.netsuite_active, true) = true
        AND COALESCE(o.fulfillment_status, '') NOT IN ('fulfilled', 'shipped')
        AND (
          $1::bigint IS NOT NULL
          OR COALESCE(l.netsuite_backordered_qty, 0) > 0.000001
        )
        AND ($1::bigint IS NULL OR o.netsuite_id = $1)
      ORDER BY o.netsuite_id
      LIMIT 500`,
    [salesOrderId === null || salesOrderId === undefined ? null : requestedId]
  );
  return result.rows.map((row) => Number(row.netsuite_id)).filter(Number.isSafeInteger);
}

async function refreshTransferDependencySalesOrderAllocations({
  salesOrderId = null,
  force = false
} = {}) {
  if (!config.netsuite.directAccessEnabled) return { refreshed: 0, skipped: "direct_access_disabled" };
  const ids = await transferDependencyAllocationOrderIds(salesOrderId);
  const cutoff = Date.now() - TRANSFER_DEPENDENCY_ALLOCATION_TTL_MS;
  const dueIds = ids.filter((id) => force || Number(transferDependencyAllocationRefreshAt.get(id) || 0) < cutoff);
  if (!dueIds.length) return { refreshed: 0, cached: ids.length };

  const run = async () => {
    const stillDue = dueIds.filter((id) => force || Number(transferDependencyAllocationRefreshAt.get(id) || 0) < cutoff);
    if (!stillDue.length) return { refreshed: 0, cached: dueIds.length };
    const linesByOrderId = await fetchDeliveryOrderDetailsBatchFromNetSuite(stillDue);
    for (const orderId of stillDue) {
      const lines = linesByOrderId.get(orderId) || [];
      await upsertSalesOrderLines(orderId, lines);
      await markMissingOutboundOrderLines(orderId, lines.map((line) => line.line_id));
      transferDependencyAllocationRefreshAt.set(orderId, Date.now());
    }
    return { refreshed: stillDue.length };
  };
  const result = transferDependencyAllocationRefreshQueue.then(run, run);
  transferDependencyAllocationRefreshQueue = result.catch(() => {});
  return result;
}

async function refreshTransferDependencyBatchSalesOrderAllocations(batchId, { force = true } = {}) {
  const result = await query(
    `SELECT sales_order_id
       FROM scm_transfer_dependency_batches
      WHERE id = $1`,
    [Number(batchId)]
  );
  if (!result.rowCount) throw Object.assign(new Error("Dependency batch not found."), { status: 404 });
  return refreshTransferDependencySalesOrderAllocations({
    salesOrderId: result.rows[0].sales_order_id,
    force
  });
}

function transferDependencyExpectedItemQuantities(proposal = {}) {
  return new Map([...transferDependencyExpectedLineTotals(proposal)].map(([itemId, line]) => [itemId, line.quantity]));
}

function transferDependencyExpectedLineTotals(proposal = {}) {
  const palletItemId = Number(proposal.palletItemId);
  const totals = new Map();
  const add = (itemId, itemName, values = {}) => {
    const current = totals.get(itemId) || {
      itemId,
      itemName: String(itemName || itemId),
      quantity: 0,
      palletQty: 0,
      layerQty: 0,
      sectionQty: 0,
      pieceQty: 0
    };
    for (const field of ["quantity", "palletQty", "layerQty", "sectionQty", "pieceQty"]) {
      current[field] += Number(values[field] || 0);
    }
    totals.set(itemId, current);
  };
  for (const line of proposal.lines || []) {
    const itemId = Number(line.itemId);
    const itemName = String(line.sku || line.itemName || "").trim().toUpperCase();
    if (!Number.isInteger(itemId) || itemId <= 0 || String(itemId) === String(palletItemId) || itemName === "PALLET") continue;
    add(itemId, line.itemName || line.sku, {
      quantity: line.proposedQuantity,
      palletQty: line.palletQty,
      layerQty: line.layerQty,
      sectionQty: line.sectionQty,
      pieceQty: line.pieceQty
    });
  }
  const palletQuantity = Number(proposal.palletTransferQuantity || 0);
  if (Number.isInteger(palletItemId) && palletItemId > 0 && palletQuantity > 0) {
    add(palletItemId, proposal.palletItemName || "PALLET", { quantity: palletQuantity, pieceQty: palletQuantity });
  }
  return totals;
}

function transferDependencyItemQuantitiesMatch(expected, lines = []) {
  const actual = new Map();
  for (const line of lines || []) {
    const itemId = Number(line.item_id ?? line.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    actual.set(itemId, Number(actual.get(itemId) || 0) + Number(line.quantity || 0));
  }
  if (actual.size !== expected.size) return false;
  for (const [itemId, quantity] of expected) {
    if (Math.abs(Number(actual.get(itemId) || 0) - quantity) > 0.000001) return false;
  }
  return true;
}

async function findCreatedDependencyTransferOrder({ proposal, batch }) {
  const expected = transferDependencyExpectedItemQuantities(proposal);
  if (!expected.size) return null;
  const exactMarker = transferDependencyMemoMarker(batch.id, proposal.id);
  const legacyMarker = `MBBS dependency batch ${batch.id}`;
  const linked = await query(
    `SELECT netsuite_transfer_order_id
       FROM scm_transfer_dependency_proposals
      WHERE netsuite_transfer_order_id IS NOT NULL
        AND id <> $1`,
    [Number(proposal.id)]
  );
  const linkedIds = new Set(linked.rows.map((row) => Number(row.netsuite_transfer_order_id)));
  const local = await query(
    `SELECT netsuite_id AS id, tranid, memo
       FROM transfer_orders
      WHERE from_location_id = $1
        AND to_location_id = $2
        AND COALESCE(netsuite_active, true) = true
        AND memo ILIKE $3
      ORDER BY CASE WHEN memo ILIKE $4 THEN 0 ELSE 1 END, netsuite_id DESC
      LIMIT 10`,
    [Number(proposal.fromLocationId), Number(proposal.toLocationId), `%${legacyMarker}%`, `%${exactMarker}%`]
  );
  const matches = [];
  for (const candidate of local.rows) {
    const candidateId = Number(candidate.id);
    if (linkedIds.has(candidateId)) continue;
    const lines = await query(
      `SELECT item_id, SUM(quantity) AS quantity
         FROM transfer_order_lines
        WHERE transfer_order_id = $1
          AND line_stage = 'outbound'
          AND COALESCE(netsuite_active, true) = true
        GROUP BY item_id`,
      [candidateId]
    );
    if (transferDependencyItemQuantitiesMatch(expected, lines.rows)) matches.push(candidate);
  }
  if (!matches.length) {
    const locations = await resolveNetSuiteTransferLocations({
      sourceLocationId: proposal.fromLocationId,
      sourceLocation: proposal.fromLocation,
      destinationLocationId: proposal.toLocationId,
      destinationLocation: proposal.toLocation
    });
    const remote = await findTransferOrdersByDependencyMarkerFromNetSuite({
      batchId: batch.id,
      proposalId: proposal.id,
      sourceLocationId: locations.source.netsuiteLocationId,
      destinationLocationId: locations.destination.netsuiteLocationId
    });
    for (const candidate of remote) {
      const candidateId = Number(candidate.id);
      if (linkedIds.has(candidateId)) continue;
      const lines = await fetchTransferOrderDetailsFromNetSuite(candidateId, locations.source.netsuiteLocationId, { direction: "source" });
      if (transferDependencyItemQuantitiesMatch(expected, lines)) matches.push(candidate);
    }
  }
  const uniqueMatches = [...new Map(matches.map((candidate) => [Number(candidate.id), candidate])).values()];
  if (uniqueMatches.length > 1) {
    throw new Error(`Multiple matching NetSuite Transfer Orders were found for proposal ${proposal.id}. Link the correct TO manually before retrying.`);
  }
  return uniqueMatches[0] ? { id: Number(uniqueMatches[0].id), recovered: true } : null;
}

async function refreshTransferDependencyInventory(itemIds = []) {
  const ids = [...new Set((itemIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const resolvedYards = await resolveNetSuiteYardLocations(DEPENDENCY_YARDS);
  const localByNetSuiteId = new Map(resolvedYards.map((yard) => [String(yard.netsuiteLocationId), yard]));
  const inventory = await fetchInventoryBalancesForItemsFromNetSuite(
    ids,
    resolvedYards.map((yard) => yard.netsuiteLocationId)
  );
  const canonicalInventory = inventory.map((row) => {
    const yard = localByNetSuiteId.get(String(row.location_id));
    return yard ? {
      ...row,
      location_id: yard.localLocationId,
      location: yard.localLocationCode
    } : row;
  });
  await upsertInventoryBalances(canonicalInventory);
  return canonicalInventory;
}

async function refreshTransferDependencyBatchInventory(batchId, operatorId = null) {
  let batch = await getTransferDependencyBatch(batchId);
  if (!batch) throw new Error("Dependency batch not found.");
  const palletItem = await resolvePalletItemFromNetSuite();
  batch = await prepareTransferDependencyPalletItem(batchId, palletItem, operatorId);
  const itemIds = [...new Set((batch.proposals || [])
    .filter((proposal) => !["created", "attention", "cancelled"].includes(proposal.creationStatus))
    .flatMap((proposal) => [
      ...(proposal.lines || []).map((line) => Number(line.itemId)),
      Number(proposal.palletTransferQuantity) > 0 ? Number(proposal.palletItemId) : null
    ])
    .filter(Number.isInteger))];
  if (itemIds.length) await refreshTransferDependencyInventory(itemIds);
  return batch;
}

async function hydrateCreatedDependencyTransferOrder(transferOrderId, proposal) {
  const order = await fetchTransferOrderByIdFromNetSuite(transferOrderId);
  if (!order) throw new Error("Created NetSuite Transfer Order was not found.");
  const sourceLocationId = Number(order.source_location_id || proposal.fromLocationId);
  const destinationLocationId = Number(order.destination_location_id || proposal.toLocationId);
  const outboundLines = await fetchTransferOrderDetailsFromNetSuite(transferOrderId, sourceLocationId, { direction: "source" });
  const receivingLines = await fetchTransferOrderDetailsFromNetSuite(transferOrderId, destinationLocationId, { direction: "destination" });
  const canonicalOrder = {
    ...order,
    source_location_id: proposal.fromLocationId,
    source_location: proposal.fromLocation,
    outbound_location_id: proposal.fromLocationId,
    outbound_location: proposal.fromLocation,
    destination_location_id: proposal.toLocationId,
    destination_location: proposal.toLocation,
    order_location_id: proposal.toLocationId,
    order_location: proposal.toLocation,
    customer_id: proposal.toLocationId,
    customer: `Transfer to ${proposal.toLocation}`
  };
  const canonicalOutboundLines = outboundLines.map((line) => ({
    ...line,
    location_id: proposal.fromLocationId,
    location: proposal.fromLocation
  }));
  const canonicalReceivingLines = receivingLines.map((line) => ({
    ...line,
    location_id: proposal.toLocationId,
    location: proposal.toLocation
  }));
  await upsertOutboundTransferOrders([canonicalOrder]);
  await upsertOutboundTransferOrderLines(transferOrderId, canonicalOutboundLines);
  await upsertInboundTransferOrders([canonicalOrder]);
  await upsertInboundTransferOrderLines(transferOrderId, canonicalReceivingLines);
  const status = String(order.status || "").trim();
  const statusText = String(order.status_text || "").trim();
  return {
    id: Number(order.id),
    tranid: order.tranid,
    status,
    statusText,
    pendingFulfillment: status.toUpperCase() === "B" || /pending fulfillment/i.test(statusText)
  };
}

function transferDependencyVerificationMismatches(proposal, remoteLines = []) {
  const expected = transferDependencyExpectedLineTotals(proposal);
  const actual = new Map();
  for (const line of remoteLines || []) {
    const itemId = Number(line.item_id ?? line.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    actual.set(itemId, {
      itemId,
      itemName: String(line.item_name || line.itemName || itemId),
      quantity: Number(line.quantity || 0),
      palletQty: Number(line.pallet_qty ?? line.palletQty ?? 0),
      layerQty: Number(line.layer_qty ?? line.layerQty ?? 0),
      sectionQty: Number(line.section_qty ?? line.sectionQty ?? 0),
      pieceQty: Number(line.piece_qty ?? line.pieceQty ?? 0)
    });
  }
  const mismatches = [];
  const fields = [
    ["quantity", "sales quantity"],
    ["palletQty", "PLT"],
    ["layerQty", "LYR"],
    ["sectionQty", "SEC"],
    ["pieceQty", "PCS"]
  ];
  for (const itemId of new Set([...expected.keys(), ...actual.keys()])) {
    const wanted = expected.get(itemId);
    const found = actual.get(itemId);
    if (!wanted) {
      mismatches.push(`${found?.itemName || itemId} exists only in NetSuite`);
      continue;
    }
    if (!found) {
      mismatches.push(`${wanted.itemName} is missing from NetSuite`);
      continue;
    }
    for (const [field, label] of fields) {
      if (Math.abs(Number(wanted[field] || 0) - Number(found[field] || 0)) > 0.000001) {
        mismatches.push(`${wanted.itemName} ${label}: local ${wanted[field] || 0}, NetSuite ${found[field] || 0}`);
      }
    }
  }
  return mismatches;
}

async function approveAndPrintTransferDependencyProposal(batchId, proposalId, operator) {
  const batch = await getTransferDependencyBatch(batchId);
  if (!batch) throw Object.assign(new Error("Dependency batch not found."), { status: 404 });
  const proposal = batch.proposals.find((row) => String(row.id) === String(proposalId));
  if (!proposal) throw Object.assign(new Error("Transfer proposal not found."), { status: 404 });
  const transferOrderId = Number(proposal.transferOrderId);
  if (!Number.isInteger(transferOrderId) || transferOrderId <= 0 || !proposal.transferOrderRef) {
    throw Object.assign(new Error("Create the NetSuite Transfer Order before approval and printing."), { status: 409 });
  }
  if (!['created', 'attention'].includes(proposal.creationStatus)) {
    throw Object.assign(new Error("This Transfer Order is not ready for approval."), { status: 409 });
  }
  if (proposal.printJob) {
    let printJob = proposal.printJob;
    if (["failed", "uncertain"].includes(printJob.status)) {
      printJob = await retrySmartScmPrintJob(printJob.id, operator?.id);
    }
    return { batch: await getTransferDependencyBatch(batchId), proposalId: proposal.id, transferOrderId, transferOrderRef: proposal.transferOrderRef, printJob, reused: true };
  }

  const locations = await resolveNetSuiteTransferLocations({
    sourceLocationId: proposal.fromLocationId,
    sourceLocation: proposal.fromLocation,
    destinationLocationId: proposal.toLocationId,
    destinationLocation: proposal.toLocation
  });
  const [order, remoteLines] = await Promise.all([
    fetchTransferOrderByIdFromNetSuite(transferOrderId),
    fetchTransferOrderVerificationLinesFromNetSuite(transferOrderId, locations.source.netsuiteLocationId)
  ]);
  const mismatches = transferDependencyVerificationMismatches(proposal, remoteLines);
  if (!order) mismatches.unshift(`${proposal.transferOrderRef} was not found in NetSuite`);
  if (order && String(order.source_location_id) !== String(locations.source.netsuiteLocationId)) {
    mismatches.unshift(`source yard: local ${proposal.fromLocation}, NetSuite ${order.source_location || order.source_location_id || "missing"}`);
  }
  if (order && String(order.destination_location_id) !== String(locations.destination.netsuiteLocationId)) {
    mismatches.unshift(`destination yard: local ${proposal.toLocation}, NetSuite ${order.destination_location || order.destination_location_id || "missing"}`);
  }
  if (mismatches.length) {
    const message = `TO verification failed: ${mismatches.slice(0, 8).join("; ")}`;
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET quantity_verification_status = 'failed', quantity_verification_error = $2,
              approval_status = 'failed', approval_error = $2, updated_at = now()
        WHERE id = $1`,
      [Number(proposal.id), message]
    );
    await writeDispatchAudit({
      action: "scm.transfer_dependency.verification_failed",
      source: "scm",
      entityType: "transfer_dependency_proposal",
      entityId: String(proposal.id),
      orderId: proposal.transferOrderRef,
      operatorId: operator?.id,
      details: { batchId: batch.id, salesOrderRef: batch.salesOrderRef, transferOrderId, mismatches }
    });
    throw Object.assign(new Error(message), { status: 409 });
  }
  await query(
    `UPDATE scm_transfer_dependency_proposals
        SET quantity_verification_status = 'verified', quantity_verification_error = NULL,
            quantity_verified_at = now(), quantity_verified_by = $2, updated_at = now()
      WHERE id = $1`,
    [Number(proposal.id), operator?.id]
  );

  const restletUrl = String(config.smartScm?.pickingTicketRestletUrl || "").trim();
  if (!restletUrl) {
    const message = "Quantity verified. SMART_SCM_PICKING_TICKET_RESTLET_URL is not configured, so the TO remains Pending Approval in Created.";
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET approval_status = 'pending', approval_error = $2, updated_at = now()
        WHERE id = $1`,
      [Number(proposal.id), message]
    );
    throw Object.assign(new Error(message), { status: 409 });
  }
  const printer = (await listYardPrinters()).find((row) => Number(row.locationId) === Number(proposal.fromLocationId));
  if (!printer?.transferOrderReady) {
    const message = `Quantity verified. ${proposal.fromLocation} requires two different TO printers, an enabled yard queue, and an agent token before approval.`;
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET approval_status = 'pending', approval_error = $2, updated_at = now()
        WHERE id = $1`,
      [Number(proposal.id), message]
    );
    throw Object.assign(new Error(message), { status: 409 });
  }

  let approved = proposal.approvalStatus === "approved";
  try {
    if (!approved) {
      const claimed = await query(
        `UPDATE scm_transfer_dependency_proposals
            SET approval_status = 'approving', approval_error = NULL, updated_at = now()
          WHERE id = $1 AND approval_status IN ('pending', 'failed')
          RETURNING id`,
        [Number(proposal.id)]
      );
      if (!claimed.rowCount) {
        throw Object.assign(new Error("This Transfer Order approval is already in progress. Refresh before retrying."), { status: 409 });
      }
      await updateTransferOrderStatusInNetSuite(transferOrderId, { intercompany: locations.intercompany, statusId: "B" });
      let approvedOrder = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        approvedOrder = await fetchTransferOrderByIdFromNetSuite(transferOrderId);
        const status = String(approvedOrder?.status || "").toUpperCase();
        if (status === "B" || /pending fulfillment/i.test(String(approvedOrder?.status_text || ""))) break;
        await new Promise((resolve) => setTimeout(resolve, 1250));
      }
      const hydrated = await hydrateCreatedDependencyTransferOrder(transferOrderId, proposal);
      if (!hydrated.pendingFulfillment) {
        throw new Error(`${proposal.transferOrderRef} did not reach Pending Fulfillment after approval.`);
      }
      approved = true;
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET creation_status = 'created', creation_error = NULL,
                approval_status = 'approved', approval_error = NULL,
                approved_at = now(), approved_by = $2, updated_at = now()
          WHERE id = $1`,
        [Number(proposal.id), operator?.id]
      );
      await query(
        `UPDATE order_dependencies
            SET status = 'active', attention_reason = NULL,
                updated_by = $2, updated_at = now()
          WHERE transfer_order_id = $1
            AND status = 'attention'
            AND attention_reason ILIKE '%instead of Pending Fulfillment%'`,
        [transferOrderId, operator?.id]
      );
    }

    const document = await fetchPickingTicketFromNetSuite(transferOrderId, { filenamePrefix: proposal.transferOrderRef });
    const printJob = await queueSmartScmPrintJob({
      proposalId: null,
      locationId: proposal.fromLocationId,
      documentType: "transfer_dependency_picking_ticket",
      documentName: document.filename,
      documentBuffer: document.buffer,
      jobKey: `transfer-dependency:${proposal.id}:picking-ticket:${proposal.transferOrderRef}`,
      sourceOrderId: transferOrderId,
      sourceOrderRef: proposal.transferOrderRef,
      lineLocationId: proposal.fromLocationId
    }, operator?.id);
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET approval_status = 'approved', approval_error = NULL,
              print_job_id = $2, updated_at = now()
        WHERE id = $1`,
      [Number(proposal.id), printJob.id]
    );
    await writeDispatchAudit({
      action: "scm.transfer_dependency.approved_print_queued",
      source: "scm",
      entityType: "transfer_dependency_proposal",
      entityId: String(proposal.id),
      orderId: proposal.transferOrderRef,
      operatorId: operator?.id,
      details: { batchId: batch.id, salesOrderRef: batch.salesOrderRef, transferOrderId, sourceYard: proposal.fromLocation, printJobId: printJob.id }
    });
    return { batch: await getTransferDependencyBatch(batchId), proposalId: proposal.id, transferOrderId, transferOrderRef: proposal.transferOrderRef, printJob };
  } catch (error) {
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET approval_status = $2, approval_error = $3, updated_at = now()
        WHERE id = $1`,
      [Number(proposal.id), approved ? "approved" : "failed", error.message]
    );
    throw error;
  }
}

async function recoverSmartScmTransferOrder({
  proposalId,
  locations,
  attempts = 1,
  delayMs = 650
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rows = await findTransferOrdersBySmartScmMarkerFromNetSuite({
      proposalId,
      sourceLocationId: locations.source.netsuiteLocationId,
      destinationLocationId: locations.destination.netsuiteLocationId
    });
    const match = selectSmartScmMarkerTransferOrder(rows, {
      proposalId,
      sourceLocationId: locations.source.netsuiteLocationId,
      destinationLocationId: locations.destination.netsuiteLocationId
    });
    if (match) return match;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  return null;
}

async function executeSmartScmTransferProposal(proposalId, operator) {
  const prepared = await prepareSmartScmTransferExecution(proposalId, operator?.id);
  let transferOrderId = null;
  let transferOrderRef = null;
  let recovered = false;
  try {
    const printers = await listYardPrinters();
    const printer = printers.find((row) => Number(row.locationId) === Number(prepared.sourceLocationId));
    if (!printer?.transferOrderReady) {
      throw new Error(`${prepared.sourceName} requires two different printers assigned to TO printing, an enabled yard queue, and an agent token before confirming this TO.`);
    }
    let document;
    if (prepared.mode === "live") {
      if (!config.smartScm.liveExecutionEnabled) {
        throw new Error("Smart SCM live execution is blocked by SMART_SCM_LIVE_EXECUTION_ENABLED=false.");
      }
      const [locations, palletItem] = await Promise.all([
        resolveNetSuiteTransferLocations({
          sourceLocationId: prepared.sourceLocationId,
          sourceLocation: prepared.sourceName,
          destinationLocationId: prepared.destinationLocationId,
          destinationLocation: prepared.destinationName
        }),
        Number(prepared.palletTransferQuantity) > 0
          ? resolvePalletItemFromNetSuite()
          : Promise.resolve(null)
      ]);
      let markerMatch = await recoverSmartScmTransferOrder({
        proposalId: prepared.id,
        locations
      });
      if (markerMatch) {
        transferOrderId = markerMatch.id;
        transferOrderRef = markerMatch.tranid || null;
        recovered = true;
      } else {
        const payload = buildTransferDependencyRestPayload({
          proposal: {
            lines: prepared.lines,
            palletItemId: palletItem?.id ?? null,
            palletTransferQuantity: prepared.palletTransferQuantity,
            memo: `${prepared.memo || "Smart SCM replenishment"} | ${smartScmTransferOrderMemoMarker(prepared.id)}`
          },
          batch: { id: `smart-${prepared.id}`, salesOrderRef: `Smart SCM run ${prepared.runId}` },
          locations
        });
        let createError = null;
        try {
          const created = await createTransferOrderInNetSuite(payload, { intercompany: locations.intercompany });
          transferOrderId = Number(created.id);
        } catch (error) {
          createError = error;
        }
        if (!Number.isInteger(transferOrderId) || transferOrderId <= 0) {
          markerMatch = await recoverSmartScmTransferOrder({
            proposalId: prepared.id,
            locations,
            attempts: 4
          });
          if (!markerMatch) {
            throw createError || new Error("NetSuite did not return a TO ID and no matching Smart SCM memo marker was found. Retry is safe after the proposal returns to Failed.");
          }
          transferOrderId = markerMatch.id;
          transferOrderRef = markerMatch.tranid || null;
          recovered = true;
        }
      }
      await updateTransferOrderStatusInNetSuite(transferOrderId, { intercompany: locations.intercompany, statusId: "B" });
      const hydrated = await hydrateCreatedDependencyTransferOrder(transferOrderId, {
        fromLocationId: prepared.sourceLocationId,
        fromLocation: prepared.sourceName,
        toLocationId: prepared.destinationLocationId,
        toLocation: prepared.destinationName
      });
      transferOrderRef = hydrated.tranid || transferOrderRef || `TO-${transferOrderId}`;
      if (!hydrated.pendingFulfillment) throw new Error(`${transferOrderRef} was created but did not reach Pending Fulfillment.`);
      await completeSmartScmTransferExecution(prepared.id, { transferOrderId, transferOrderRef, mock: false }, operator?.id);
      document = await fetchPickingTicketFromNetSuite(transferOrderId, {
        locationId: locations.source.netsuiteLocationId,
        filenamePrefix: transferOrderRef
      });
    } else {
      transferOrderRef = `MOCK-TO-${prepared.id}`;
      await completeSmartScmTransferExecution(prepared.id, { transferOrderId: null, transferOrderRef, mock: true }, operator?.id);
      document = {
        filename: `${transferOrderRef}-picking-ticket.pdf`,
        buffer: createSimplePdf([
          "MBBS Smart SCM — MOCK Picking Ticket",
          `Reference: ${transferOrderRef}`,
          `From: ${prepared.sourceName}`,
          `To: ${prepared.destinationName}`,
          `Material pallets: ${prepared.totalPallets}`,
          `PALLET item: ${prepared.palletTransferQuantity}`,
          ...prepared.lines.map((line) => `${line.itemName}: ${line.palletQty} PLT`),
          "No NetSuite record was created."
        ])
      };
    }
    const printJob = await queueSmartScmPrintJob({
      proposalId: prepared.id,
      locationId: prepared.sourceLocationId,
      documentType: "picking_ticket",
      documentName: document.filename,
      documentBuffer: document.buffer,
      jobKey: `smart-scm:${prepared.id}:picking-ticket:${transferOrderRef}`
    }, operator?.id);
    emitAppEvent("scm.smart.updated", { source: "smart-scm-transfer", proposalId: prepared.id, transferOrderId, transferOrderRef });
    if (transferOrderId) emitAppEvent("dispatch.orders.updated", { source: "smart-scm-transfer", refreshOrderPool: true });
    return { proposalId: prepared.id, mode: prepared.mode, transferOrderId, transferOrderRef, printJob, recovered };
  } catch (error) {
    if (transferOrderId || transferOrderRef?.startsWith("MOCK-TO-") || error.smartScmAttention) {
      await markSmartScmTransferAttention(prepared.id, { transferOrderId, transferOrderRef, error }, operator?.id);
    } else {
      await failSmartScmTransferExecution(prepared.id, error, operator?.id);
    }
    throw error;
  }
}

async function retrySmartScmTransferPrint(proposalId, operator) {
  const proposal = await getSmartScmProposal(proposalId);
  if (!proposal) throw Object.assign(new Error("Smart SCM proposal was not found."), { status: 404 });
  if (proposal.proposalType !== "TO") throw Object.assign(new Error("Only a TO proposal has a picking ticket."), { status: 400 });
  if (!proposal.netsuiteTransferOrderId && !String(proposal.netsuiteTransferOrderRef || "").startsWith("MOCK-TO-")) {
    throw Object.assign(new Error("This proposal has no created TO reference to recover."), { status: 409 });
  }
  const printers = await listYardPrinters();
  const printer = printers.find((row) => Number(row.locationId) === Number(proposal.sourceLocationId));
  if (!printer?.transferOrderReady) {
    throw Object.assign(new Error(`${proposal.sourceName} requires two different printers assigned to TO printing, an enabled yard queue, and an agent token.`), { status: 409 });
  }
  let transferOrderRef = proposal.netsuiteTransferOrderRef || `TO-${proposal.netsuiteTransferOrderId}`;
  let document;
  if (proposal.netsuiteTransferOrderId) {
    const locations = await resolveNetSuiteTransferLocations({
      sourceLocationId: proposal.sourceLocationId,
      sourceLocation: proposal.sourceName,
      destinationLocationId: proposal.destinationLocationId,
      destinationLocation: proposal.destinationName
    });
    await updateTransferOrderStatusInNetSuite(proposal.netsuiteTransferOrderId, {
      intercompany: locations.intercompany,
      statusId: "B"
    });
    const hydrated = await hydrateCreatedDependencyTransferOrder(proposal.netsuiteTransferOrderId, {
      fromLocationId: proposal.sourceLocationId,
      fromLocation: proposal.sourceName,
      toLocationId: proposal.destinationLocationId,
      toLocation: proposal.destinationName
    });
    transferOrderRef = hydrated.tranid || transferOrderRef;
    if (!hydrated.pendingFulfillment) {
      throw new Error(`${transferOrderRef} did not reach Pending Fulfillment before picking-ticket recovery.`);
    }
    document = await fetchPickingTicketFromNetSuite(proposal.netsuiteTransferOrderId, {
      locationId: locations.source.netsuiteLocationId,
      filenamePrefix: transferOrderRef
    });
  } else {
    document = {
      filename: `${transferOrderRef}-picking-ticket.pdf`,
      buffer: createSimplePdf([
        "MBBS Smart SCM — MOCK Picking Ticket",
        `Reference: ${transferOrderRef}`,
        `From: ${proposal.sourceName}`,
        `To: ${proposal.destinationName}`,
        `Pallets: ${proposal.totalPallets}`,
        ...proposal.lines.map((line) => `${line.itemName}: ${line.proposedPallets} PLT`),
        "No NetSuite record was created."
      ])
    };
  }
  let printJob = await queueSmartScmPrintJob({
    proposalId: proposal.id,
    locationId: proposal.sourceLocationId,
    documentType: "picking_ticket",
    documentName: document.filename,
    documentBuffer: document.buffer,
    jobKey: `smart-scm:${proposal.id}:picking-ticket:${transferOrderRef}`
  }, operator?.id);
  if (["failed", "uncertain"].includes(printJob.status)) {
    printJob = await retrySmartScmPrintJob(printJob.id, operator?.id);
  }
  await completeSmartScmTransferExecution(proposal.id, {
    transferOrderId: proposal.netsuiteTransferOrderId,
    transferOrderRef,
    mock: !proposal.netsuiteTransferOrderId
  }, operator?.id);
  emitAppEvent("scm.smart.updated", { source: "smart-scm-print-retry", proposalId: proposal.id, printJobId: printJob.id });
  if (proposal.netsuiteTransferOrderId) {
    emitAppEvent("dispatch.orders.updated", { source: "smart-scm-print-retry", refreshOrderPool: true });
  }
  return { proposalId: proposal.id, transferOrderId: proposal.netsuiteTransferOrderId, transferOrderRef, printJob };
}

async function findDispatchPlanDateConflicts({
  planId,
  planDate,
  orders = [],
  trucks = [],
  candidateRefs = []
} = {}) {
  const currentRefs = dispatchPlannedOrderRefs({ orders, trucks });
  if (!currentRefs.size) return [];
  const searchRefs = [...new Set((candidateRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean))];
  const result = searchRefs.length ? await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
       CROSS JOIN LATERAL (
         SELECT COALESCE(array_agg(assigned_order.value ->> 'id')
                  FILTER (WHERE COALESCE(assigned_order.value ->> 'id', '') <> ''), ARRAY[]::text[]) AS order_ids
           FROM jsonb_array_elements(COALESCE(s.orders, '[]'::jsonb)) assigned_order(value)
          WHERE assigned_order.value ->> 'id' = ANY($3::text[])
             OR assigned_order.value ->> 'originalOrderId' = ANY($3::text[])
             OR (
               upper(COALESCE(assigned_order.value ->> 'type', '')) <> 'CUSTOM'
               AND assigned_order.value ->> 'id' ~* '-S[0-9]+$'
               AND regexp_replace(assigned_order.value ->> 'id', '-S[0-9]+$', '', 'i') = ANY($3::text[])
             )
             OR COALESCE(assigned_order.value -> 'childOrders', '[]'::jsonb) ?| $3::text[]
             OR EXISTS (
               SELECT 1
                 FROM unnest($3::text[]) candidate(ref)
                WHERE jsonb_path_exists(
                        COALESCE(assigned_order.value -> 'childOrderDetails', '[]'::jsonb),
                        '$.**.id ? (@ == $ref)',
                        jsonb_build_object('ref', candidate.ref)
                      )
                   OR jsonb_path_exists(
                        COALESCE(assigned_order.value -> 'childOrderDetails', '[]'::jsonb),
                        '$.**.originalOrderId ? (@ == $ref)',
                        jsonb_build_object('ref', candidate.ref)
                      )
             )
       ) related_orders
      WHERE p.id <> $1
        AND p.status <> 'cancelled'
        AND p.plan_date <> $2::date
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(COALESCE(s.trucks, '[]'::jsonb)) truck(value)
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb)) load(value)
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb)) stop(value)
           WHERE lower(COALESCE(load.value ->> 'returnOnly', 'false')) <> 'true'
             AND stop.value ->> 'type' = 'drop'
             AND (
               stop.value ->> 'orderId' = ANY($3::text[])
               OR stop.value ->> 'orderId' = ANY(related_orders.order_ids)
             )
        )`,
    [planId, planDate, searchRefs]
  ) : await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id <> $1
        AND p.status <> 'cancelled'
        AND p.plan_date <> $2::date`,
    [planId, planDate]
  );
  const conflicts = [];
  for (const row of result.rows) {
    const otherPlan = { orders: row.orders || [], trucks: row.trucks || [] };
    for (const ref of dispatchPlannedOrderConflictRefs({ orders, trucks }, otherPlan)) {
      conflicts.push({
        orderRef: ref,
        planId: String(row.id),
        planDate: row.plan_date,
        status: row.status || ""
      });
    }
  }
  return conflicts.sort((a, b) => `${a.planDate}|${a.orderRef}`.localeCompare(`${b.planDate}|${b.orderRef}`));
}

async function findNewDispatchPlanDateConflicts(previousPlan = {}, nextPlan = {}) {
  const previousRefs = dispatchPlannedOrderRefs(previousPlan);
  const nextRefs = dispatchPlannedOrderRefs(nextPlan);
  const newlyPlannedRefs = new Set([...nextRefs].filter((ref) => !previousRefs.has(ref)));
  if (!newlyPlannedRefs.size) return [];
  const conflictSearchRefs = new Set(newlyPlannedRefs);
  for (const order of nextPlan.orders || []) {
    const orderRef = String(order?.id || "").trim();
    const explicitParentRef = String(order?.originalOrderId || "").trim();
    const inferredParentRef = String(order?.type || "").trim().toUpperCase() !== "CUSTOM" && /-S\d+$/i.test(orderRef)
      ? orderRef.replace(/-S\d+$/i, "")
      : "";
    const parentRef = explicitParentRef || inferredParentRef;
    if (orderRef && parentRef && (newlyPlannedRefs.has(orderRef) || newlyPlannedRefs.has(parentRef))) {
      conflictSearchRefs.add(orderRef);
      conflictSearchRefs.add(parentRef);
    }
  }
  const nextConflicts = await findDispatchPlanDateConflicts({
    planId: nextPlan.id || previousPlan.id,
    planDate: nextPlan.planDate || previousPlan.planDate,
    orders: nextPlan.orders || [],
    trucks: nextPlan.trucks || [],
    candidateRefs: [...conflictSearchRefs]
  });
  return nextConflicts.filter((conflict) => newlyPlannedRefs.has(String(conflict.orderRef || "")));
}

function dispatchDateCompare(a, b) {
  const left = String(a || "").slice(0, 10);
  const right = String(b || "").slice(0, 10);
  if (!left || !right || left === right) return 0;
  return left < right ? -1 : 1;
}

function dispatchTimingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dispatchOrderDropOccurrences(plan = {}, orderRef = "") {
  const target = String(orderRef || "");
  const occurrences = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || String(stop?.orderId || "") !== target) continue;
        occurrences.push({ truck, load, stop });
      }
    }
  }
  return occurrences;
}

function dispatchSourcePickupMinute(occurrence = {}) {
  const load = occurrence.load || {};
  const orderRef = String(occurrence.stop?.orderId || "");
  const pickup = (load.stops || []).find((stop) =>
    stop?.type === "pick" && String(stop?.orderId || "") === orderRef
  );
  return dispatchTimingNumber(pickup?.timing?.arrival) ?? dispatchTimingNumber(load.timing?.start);
}

function dispatchCoFinishMinute(occurrence = {}) {
  return dispatchTimingNumber(occurrence.load?.timing?.finish)
    ?? dispatchTimingNumber(occurrence.stop?.timing?.depart);
}

async function dispatchPlansForCoValidation(nextPlan = {}, requiredCoRefs = []) {
  const refs = [...new Set((requiredCoRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean))];
  if (!refs.length) return [nextPlan];
  const result = await query(
    `SELECT DISTINCT ON (p.id, stop.value ->> 'orderId')
            p.id,
            p.plan_date::text AS plan_date,
            stop.value ->> 'orderId' AS co_ref,
            CASE
              WHEN COALESCE(load.value -> 'timing' ->> 'finish', '') ~ '^-?[0-9]+([.][0-9]+)?$'
                THEN (load.value -> 'timing' ->> 'finish')::numeric
              WHEN COALESCE(stop.value -> 'timing' ->> 'depart', '') ~ '^-?[0-9]+([.][0-9]+)?$'
                THEN (stop.value -> 'timing' ->> 'depart')::numeric
              ELSE NULL
            END AS finish
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.trucks, '[]'::jsonb))
         WITH ORDINALITY AS truck(value, position)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb))
         WITH ORDINALITY AS load(value, position)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb))
         WITH ORDINALITY AS stop(value, position)
      WHERE p.status <> 'cancelled'
        AND p.id <> $1
        AND lower(COALESCE(load.value ->> 'returnOnly', 'false')) <> 'true'
        AND stop.value ->> 'type' = 'drop'
        AND stop.value ->> 'orderId' = ANY($2::text[])
      ORDER BY p.id, stop.value ->> 'orderId', truck.position, load.position, stop.position`,
    [nextPlan.id || 0, refs]
  );
  return [
    nextPlan,
    ...result.rows.map((row) => ({
      id: String(row.id || ""),
      planDate: row.plan_date,
      orders: [{ id: String(row.co_ref || ""), type: "CO" }],
      trucks: [{ loads: [{
        timing: row.finish === null || row.finish === undefined ? {} : { finish: Number(row.finish) },
        stops: [{
          type: "drop",
          orderId: String(row.co_ref || ""),
          timing: row.finish === null || row.finish === undefined ? {} : { depart: Number(row.finish) }
        }]
      }] }]
    }))
  ];
}

async function findDispatchCoSequenceConflicts(nextPlan = {}) {
  const sourcePlanDate = String(nextPlan.planDate || "").slice(0, 10);
  const requiredCoRefs = [...new Set((nextPlan.orders || [])
    .map((order) => String(order?.transitCo?.id || "").trim())
    .filter(Boolean))];
  if (!requiredCoRefs.length) return [];
  const candidatePlans = await dispatchPlansForCoValidation(nextPlan, requiredCoRefs);
  const coOccurrences = new Map();
  for (const plan of candidatePlans) {
    const planDate = String(plan.planDate || "").slice(0, 10);
    const coRefs = new Set((plan.orders || [])
      .filter((order) => order?.type === "CO")
      .map((order) => String(order?.id || ""))
      .filter(Boolean));
    for (const truck of plan.trucks || []) {
      for (const load of truck.loads || []) {
        for (const stop of load.stops || []) {
          const ref = String(stop?.orderId || "");
          if (stop?.type === "drop" && ref.startsWith("CO-")) coRefs.add(ref);
        }
      }
    }
    for (const coRef of coRefs) {
      const occurrence = dispatchOrderDropOccurrences(plan, coRef)[0];
      if (!occurrence) continue;
      const finish = dispatchCoFinishMinute(occurrence);
      const current = coOccurrences.get(coRef);
      if (!current || dispatchDateCompare(planDate, current.planDate) < 0) {
        coOccurrences.set(coRef, { coRef, planDate, finish });
      }
    }
  }

  const conflicts = [];
  for (const source of nextPlan.orders || []) {
    const sourceRef = String(source?.id || "");
    const coRef = String(source?.transitCo?.id || "");
    if (!sourceRef || !coRef || source?.type === "CO") continue;
    const sourceOccurrences = dispatchOrderDropOccurrences(nextPlan, sourceRef);
    if (!sourceOccurrences.length) continue;
    const co = coOccurrences.get(coRef);
    if (!co) {
      conflicts.push({ orderRef: sourceRef, coRef, reason: `${sourceRef} requires ${coRef} to be planned first.` });
      continue;
    }
    const dateCompare = dispatchDateCompare(co.planDate, sourcePlanDate);
    if (dateCompare > 0) {
      conflicts.push({ orderRef: sourceRef, coRef, coPlanDate: co.planDate, sourcePlanDate, reason: `${coRef} is planned after ${sourceRef}.` });
      continue;
    }
    if (dateCompare < 0) continue;
    const sourcePickup = dispatchSourcePickupMinute(sourceOccurrences[0]);
    if (!Number.isFinite(Number(co.finish)) || !Number.isFinite(Number(sourcePickup))) {
      continue;
    }
    if (Number(co.finish) > Number(sourcePickup)) {
      conflicts.push({
        orderRef: sourceRef,
        coRef,
        coPlanDate: co.planDate,
        sourcePlanDate,
        coFinish: Number(co.finish),
        sourcePickup: Number(sourcePickup),
        reason: `${coRef} must finish before ${sourceRef} pickup.`
      });
    }
  }
  return conflicts;
}

async function findChangedDispatchCoSequenceConflicts(_previousPlan = {}, nextPlan = {}) {
  if (!(nextPlan.orders || []).some((order) => String(order?.transitCo?.id || "").trim())) return [];
  return findDispatchCoSequenceConflicts(nextPlan);
}

function sendDispatchPlanDateConflictResponse(res, conflicts = []) {
  const preview = conflicts.slice(0, 5).map((item) => `${item.orderRef} on ${item.planDate}`).join(", ");
  res.status(409).json({
    code: "DISPATCH_ORDER_ALREADY_PLANNED",
    error: `Some orders are already planned on another date${preview ? `: ${preview}` : "."}`,
    conflicts
  });
}

function sendDispatchCoSequenceConflictResponse(res, conflicts = []) {
  const preview = conflicts.slice(0, 3).map((item) => item.reason).join(" ");
  res.status(409).json({
    code: "DISPATCH_CO_SEQUENCE_INVALID",
    error: preview || "CO must be planned before the original order pickup.",
    conflicts
  });
}

async function sendStaleDispatchPlanResponse(res, error) {
  const latest = await getDispatchPlan(error.planId).catch(() => null);
  res.status(409).json({
    error: error.message,
    code: error.code,
    planId: String(error.planId || ""),
    expectedRevision: error.expectedRevision,
    currentRevision: error.currentRevision,
    plan: latest
  });
}

function dispatchPlanStopIds(plan) {
  return new Set((plan?.trucks || []).flatMap((truck) =>
    (truck.loads || []).flatMap((load) => (load.stops || []).map((stop) => String(stop.id || "")))
  ));
}

function sanitizeDispatchPlanOrders(orders = []) {
  const groupedChildren = new Set();
  const splitParents = new Set();
  for (const order of orders || []) {
    for (const childId of order?.childOrders || []) {
      if (childId) groupedChildren.add(String(childId));
    }
    const originalOrderId = String(order?.originalOrderId || "").trim();
    if (originalOrderId) splitParents.add(originalOrderId);
  }
  return (orders || []).filter((order) => {
    const id = String(order?.id || "");
    return !groupedChildren.has(id) && !splitParents.has(id);
  });
}

function dispatchCoAssignments(plan = {}) {
  const assignments = new Map();
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      const loadAssignment = dispatchLoadAssignment(truck, load);
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop") continue;
        const coRef = String(stop.orderId || "").trim();
        if (!coRef.startsWith("CO-")) continue;
        assignments.set(coRef, {
          coRef,
          planId: plan.id || null,
          planDate: String(plan.planDate || "").slice(0, 10),
          truckPlate: loadAssignment.truckPlate,
          loadName: load.name || "",
          parkingSpot: loadAssignment.parkingSpot
        });
      }
    }
  }
  return assignments;
}

async function applyDispatchPlanCoAssignments(plan = {}) {
  if (!plan?.id || !plan?.planDate) return { planned: 0, cleared: 0 };
  const assignments = dispatchCoAssignments(plan);
  const refs = [...assignments.keys()];
  const cleared = await query(
    `UPDATE local_co_orders
        SET dispatch_plan_id = NULL,
            dispatch_plan_date = NULL,
            dispatch_truck_plate = '',
            dispatch_load_name = '',
            dispatch_parking_spot = '',
            updated_at = now()
      WHERE status NOT IN ('received', 'loaded')
        AND (
          dispatch_plan_id = $1
          OR dispatch_plan_date = $2::date
        )
        AND NOT (co_ref = ANY($3::text[]))
      RETURNING co_ref`,
    [plan.id, plan.planDate, refs]
  );
  for (const assignment of assignments.values()) {
    await query(
      `UPDATE local_co_orders
          SET dispatch_plan_id = $2,
              dispatch_plan_date = $3::date,
              dispatch_truck_plate = $4,
              dispatch_load_name = $5,
              dispatch_parking_spot = $6,
              updated_at = now()
        WHERE co_ref = $1
          AND status NOT IN ('received', 'loaded')`,
      [
        assignment.coRef,
        assignment.planId,
        assignment.planDate || null,
        assignment.truckPlate,
        assignment.loadName,
        assignment.parkingSpot
      ]
    );
  }
  return { planned: refs.length, cleared: cleared.rowCount };
}

async function runDispatchPlanPostCommitFollowup({
  plan,
  committedAction,
  stage,
  code,
  label,
  sessionId = "",
  operator = null,
  followupWarnings
}, callback) {
  try {
    return await callback();
  } catch (error) {
    const errorMessage = String(error?.message || error || "Unknown error").trim() || "Unknown error";
    const warning = {
      code,
      stage,
      step: stage,
      label,
      message: errorMessage,
      summary: `${label} failed after the dispatch plan was ${committedAction}. The plan itself was ${committedAction} successfully.`
    };
    followupWarnings.push(warning);
    console.error(
      `Dispatch plan ${committedAction} follow-up failed (${stage}) for plan ${plan?.id || "unknown"} revision ${plan?.revision || "unknown"}:`,
      error
    );
    await writeDispatchAudit({
      action: "dispatch_plan_followup_failed",
      entityType: "plan",
      entityId: String(plan?.id || ""),
      planId: plan?.id,
      planDate: plan?.planDate,
      sessionId,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      source: "dispatch",
      after: {
        revision: plan?.revision,
        status: plan?.status,
        savedAt: plan?.savedAt
      },
      details: {
        committedAction,
        warning,
        errorName: String(error?.name || "Error")
      }
    }).catch((auditError) => {
      console.error(
        `Dispatch plan follow-up failure audit could not be written for plan ${plan?.id || "unknown"} (${stage}):`,
        auditError
      );
    });
    return null;
  }
}

function shippedDispatchCsv(plan, driverJobStatuses = []) {
  const ordersById = new Map((plan.orders || []).map((order) => [String(order.id || ""), order]));
  const currentStopIds = dispatchPlanStopIds(plan);
  const rows = [["Order Number", "Transaction Type", "Weight", "Tracking Number", "Label Integration"]];
  const exported = new Set();
  const completedRefs = new Set();

  for (const record of driverJobStatuses) {
    if (record.status !== "complete" || record.stop_type !== "dropoff") continue;
    if (!currentStopIds.has(String(record.stop_id || ""))) continue;
    for (const ref of record.order_refs || []) {
      const orderRef = String(ref || "").trim();
      if (!orderRef || orderRef.startsWith("CO-")) continue;
      completedRefs.add(orderRef);
    }
  }

  for (const orderRef of completedRefs) {
    const order = ordersById.get(orderRef) || {};
    const originalRef = order.originalOrderId || "";
    if (originalRef) {
      const splitRefs = (plan.orders || [])
        .filter((item) => String(item.originalOrderId || "") === String(originalRef))
        .map((item) => String(item.id || ""))
        .filter(Boolean);
      if (!splitRefs.length || splitRefs.some((ref) => !completedRefs.has(ref))) continue;
    }
    const exportRef = order.sourceOrderId || order.relatedSoId || originalRef || orderRef;
    const key = `${exportRef}|${orderTransactionType(orderRef, order)}`;
    if (exported.has(key)) continue;
    exported.add(key);
    rows.push([exportRef, orderTransactionType(orderRef, order), "", "", ""]);
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function monitorOrderSummary(order) {
  if (!order) return null;
  return {
    id: order.id || "",
    type: order.type || "",
    customer: order.customer || order.vendor || "",
    address: order.address || order.dropAddress || "",
    windowStart: order.windowStart || "",
    windowEnd: order.windowEnd || ""
  };
}

function monitorPlanOrder(plan = {}, orderRef = "") {
  const ref = String(orderRef || "");
  const direct = (plan.orders || []).find((order) => String(order?.id || "") === ref);
  if (direct) return direct;
  for (const order of plan.orders || []) {
    const child = (order?.childOrderDetails || []).find((item) => String(item?.id || "") === ref);
    if (child) return child;
  }
  return null;
}

function monitorPlannedItemLines(order = {}, stop = {}) {
  const source = Array.isArray(order.items) && order.items.length
    ? order.items
    : Array.isArray(order.raw?.items) ? order.raw.items : [];
  const lineRowIds = new Set((stop.lineRowIds || []).map(String));
  const scoped = lineRowIds.size
    ? source.filter((item) => lineRowIds.has(String(item.lineRowId ?? item.line_row_id ?? item.id ?? "")))
    : source;
  const selected = lineRowIds.size ? scoped : source;
  return selected.map((item) => ({
    itemName: item.itemName || item.name || item.sku || "Item",
    quantity: Number(item.quantity ?? item.salesQty ?? 0),
    unit: item.unit || item.uom || "",
    pallets: Number(item.pallets ?? item.pallet_qty ?? 0),
    layers: Number(item.layers ?? item.layer_qty ?? 0),
    sections: Number(item.sections ?? item.section_qty ?? 0),
    pieces: Number(item.pieces ?? item.piece_qty ?? 0)
  }));
}

function monitorStopRecord(driverJobStatuses = [], assignment = {}, load = {}, stop = {}) {
  return driverJobStatuses.find((record) =>
    normalizedPlate(record.truck_plate || record.truckPlate) === normalizedPlate(assignment.truckPlate || assignment.plate)
    && String(record.load_id || record.loadId || "") === String(load.id || "")
    && String(record.stop_id || record.stopId || "") === String(stop.id || "")
  ) || null;
}

function monitorOrderExecutionStatus(plan = {}, orderRef = "", driverJobStatuses = []) {
  const ref = String(orderRef || "");
  const currentStopIds = new Set();
  const statuses = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      const assignment = dispatchLoadAssignment(truck, load);
      for (const stop of load.stops || []) {
        currentStopIds.add(String(stop.id || ""));
        if (String(stop.orderId || "") !== ref) continue;
        statuses.push(monitorStopRecord(driverJobStatuses, assignment, load, stop)?.status || "pending");
      }
    }
  }
  for (const record of driverJobStatuses) {
    if (!currentStopIds.has(String(record.stop_id || record.stopId || ""))) continue;
    const refs = record.order_refs || record.orderRefs || [];
    if (refs.map(String).includes(ref)) statuses.push(record.status || "pending");
  }
  if (!statuses.length) return "pending";
  if (statuses.every((status) => status === "complete")) return "complete";
  if (statuses.some((status) => status === "complete" || status === "in_progress")) return "in_progress";
  return "pending";
}

function monitorForecastForStop(forecast = null, load = {}, stop = {}) {
  if (!forecast || !Array.isArray(forecast.stops)) return null;
  const loadId = String(load.id || "");
  const stopId = String(stop.id || "");
  return forecast.stops.find((item) =>
    String(item.loadId || "") === loadId
    && (item.visitStopIds || [item.stopId]).map(String).includes(stopId)
  ) || null;
}

export function monitorPlannedOrders(plan, driverJobStatuses = [], forecast = null) {
  if (!plan) return [];
  const rows = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      const assignment = dispatchLoadAssignment(truck, load);
      const stops = Array.isArray(load.stops) ? load.stops : [];
      for (let stopIndex = 0; stopIndex < stops.length; stopIndex += 1) {
        const stop = stops[stopIndex];
        if (stop?.type !== "drop" || !stop.orderId) continue;
        const order = monitorPlanOrder(plan, stop.orderId) || {};
        const pickupStops = stops.filter((candidate) =>
          candidate?.type === "pick" && String(candidate.orderId || "") === String(stop.orderId || "")
        );
        const fallbackPickups = Array.isArray(order.pickupLocations) ? order.pickupLocations : [];
        const fromLocations = [...new Set([
          ...pickupStops.map((candidate) => candidate.location),
          order.sourceYard,
          ...fallbackPickups
        ].map((value) => String(value || "").trim()).filter(Boolean))];
        const record = monitorStopRecord(driverJobStatuses, assignment, load, stop);
        const stopForecast = monitorForecastForStop(forecast, load, stop);
        rows.push({
          key: `${assignment.truckId || assignment.truckPlate || truck.id || truck.plate || "truck"}:${load.id || "load"}:${stop.id || stopIndex}`,
          orderRef: String(stop.orderId || ""),
          orderType: order.type || "",
          fromLocation: fromLocations.join(" + ") || assignment.switchYard || truck.baseYard || truck.base || "—",
          destination: stop.dropLocation
            || stop.dropAddress
            || stop.destinationYard
            || order.destinationYard
            || order.destinationAddress
            || order.address
            || stop.location
            || "—",
          driver: assignment.driverName || assignment.driverLogin || "—",
          driverLogin: assignment.driverLogin || "",
          vehiclePlate: assignment.truckPlate || "—",
          truckPlate: assignment.truckPlate || "",
          parkingSpot: assignment.parkingSpot || "",
          loadId: load.id || "",
          loadName: load.name || "Load",
          plannedStart: dispatchTimingNumber(stop.timing?.arrival) ?? dispatchTimingNumber(load.timing?.finish),
          plannedEnd: dispatchTimingNumber(stop.timing?.depart)
            ?? dispatchTimingNumber(stop.timing?.arrival)
            ?? dispatchTimingNumber(load.timing?.finish),
          actualStart: record?.started_at || record?.startedAt || "",
          actualEnd: record?.completed_at || record?.completedAt || "",
          forecastStart: stopForecast?.forecastArrival || null,
          forecastEnd: stopForecast?.forecastLeave || null,
          status: monitorOrderExecutionStatus(plan, stop.orderId, driverJobStatuses),
          items: monitorPlannedItemLines(order, stop)
        });
      }
    }
  }
  return rows;
}

function monitorLoadForTruck(plan, truck, driverJobStatuses = []) {
  if (!plan || !truck) return null;
  const ordersById = new Map((plan.orders || []).map((order) => [String(order.id || ""), order]));
  const plate = normalizedPlate(truck.plate);
  const loads = [];
  for (const parentTruck of plan.trucks || []) {
    for (const load of parentTruck.loads || []) {
      const assignment = dispatchLoadAssignment(parentTruck, load);
      if (normalizedPlate(assignment.truckPlate) === plate) loads.push({ parentTruck, load, assignment });
    }
  }
  loads.sort((left, right) =>
    (left.assignment.plannedStartMinute ?? Number.MAX_SAFE_INTEGER) - (right.assignment.plannedStartMinute ?? Number.MAX_SAFE_INTEGER)
      || left.assignment.driverSequence - right.assignment.driverSequence
  );
  for (const entry of loads) {
    const { load, assignment } = entry;
    const loadStatuses = driverJobStatuses.filter((record) =>
      normalizedPlate(record.truck_plate || record.truckPlate) === plate
      && String(record.load_id || record.loadId || "") === String(load.id || "")
    );
    const statusByStop = new Map(loadStatuses.map((record) => [String(record.stop_id || record.stopId || ""), record.status || ""]));
    const plannedStops = Array.isArray(load.stops) ? load.stops : [];
    const started = loadStatuses.some((record) => ["in_progress", "complete"].includes(record.status));
    const complete = load.returnOnly
      ? loadStatuses.length > 0 && loadStatuses.every((record) => record.status === "complete")
      : plannedStops.length > 0 && plannedStops.every((stop) => statusByStop.get(String(stop.id || "")) === "complete");
    if (!started || complete) continue;
    const orderIds = [...new Set(plannedStops.map((stop) => String(stop.orderId || "")).filter(Boolean))];
    const currentStatus = loadStatuses.find((record) => record.status === "in_progress") || null;
    return {
      loadId: load.id || "",
      loadName: load.name || "Load",
      driver: assignment.driverName || "",
      driverLogin: assignment.driverLogin || "",
      truckPlate: assignment.truckPlate || truck.plate || "",
      parkingSpot: assignment.parkingSpot || "",
      status: currentStatus ? "in_progress" : "started",
      orderIds,
      orders: orderIds.map((id) => monitorOrderSummary(ordersById.get(id))).filter(Boolean),
      stops: plannedStops.map((stop, index) => ({
        id: stop.id || "",
        sequence: index + 1,
        type: stop.type || "",
        location: stop.location || "",
        orderId: stop.orderId || "",
        status: statusByStop.get(String(stop.id || "")) || "pending"
      })),
      startedAt: loadStatuses.find((record) => record.started_at)?.started_at || "",
      completedStops: plannedStops.filter((stop) => statusByStop.get(String(stop.id || "")) === "complete").length,
      stopCount: plannedStops.length
    };
  }
  return null;
}

function uniqueYardLocations(yards = []) {
  const seen = new Set();
  return yards.map((yard) => ({
    id: yard.id || yard.code || `${yard.vendor || ""}-${yard.yard || yard.name || ""}`,
    type: yard.type || "vendor",
    code: yard.code || "",
    name: yard.name || yard.yard || "",
    vendor: yard.vendor || "",
    address: yard.address || "",
    lat: yard.lat ?? null,
    lng: yard.lng ?? null,
    active: yard.active !== false
  })).filter((yard) => {
    if (!yard.address && !(yard.lat && yard.lng)) return false;
    const key = `${yard.type}|${yard.code}|${yard.vendor}|${yard.name}|${yard.address}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCanadaCoordinate(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= 41
    && lat <= 84
    && lng >= -142
    && lng <= -52;
}

function normalizedLocationText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function coordinateDistanceMeters(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const fromLat = Number(fromLatitude);
  const fromLng = Number(fromLongitude);
  const toLat = Number(toLatitude);
  const toLng = Number(toLongitude);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) return 0;
  const earthRadiusMeters = 6371000;
  const lat1 = fromLat * Math.PI / 180;
  const lat2 = toLat * Math.PI / 180;
  const deltaLat = (toLat - fromLat) * Math.PI / 180;
  const deltaLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function truckLocationChanged(previous, truck) {
  if (!previous) return true;
  const distance = coordinateDistanceMeters(previous.latitude, previous.longitude, truck.latitude, truck.longitude);
  const previousText = normalizedLocationText(previous.formatted_location);
  const nextText = normalizedLocationText(truck.formattedLocation);
  return distance >= 25 || (previousText && nextText && previousText !== nextText);
}

async function recordTruckLocationHistory(trucks = []) {
  const fresh = (trucks || []).filter((truck) =>
    truck.plate
    && truck.locationTime
    && isCanadaCoordinate(truck.latitude, truck.longitude)
  );
  if (!fresh.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const truck of fresh) {
      const latest = await client.query(
        `SELECT latitude, longitude, formatted_location
           FROM dispatch_truck_location_history
          WHERE plate = $1
          ORDER BY location_time DESC
          LIMIT 1`,
        [truck.plate]
      );
      if (!truckLocationChanged(latest.rows[0], truck)) continue;
      await client.query(
        `INSERT INTO dispatch_truck_location_history (
           plate, vehicle_id, vehicle_name, latitude, longitude, heading_degrees,
           speed_miles_per_hour, formatted_location, location_time
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
         ON CONFLICT (plate, location_time) DO UPDATE SET
           vehicle_id = EXCLUDED.vehicle_id,
           vehicle_name = EXCLUDED.vehicle_name,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           heading_degrees = EXCLUDED.heading_degrees,
           speed_miles_per_hour = EXCLUDED.speed_miles_per_hour,
           formatted_location = EXCLUDED.formatted_location`,
        [
          truck.plate,
          truck.vehicleId || "",
          truck.vehicleName || "",
          Number(truck.latitude),
          Number(truck.longitude),
          Number.isFinite(Number(truck.headingDegrees)) ? Number(truck.headingDegrees) : null,
          Number(truck.speedMilesPerHour || 0) || 0,
          truck.formattedLocation || "",
          truck.locationTime
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function truckLocationTrails(plates = []) {
  const normalizedPlates = [...new Set((plates || []).map((plate) => String(plate || "").trim()).filter(Boolean))];
  if (!normalizedPlates.length) return {};
  const result = await pool.query(
    `SELECT plate, latitude, longitude, heading_degrees, speed_miles_per_hour,
            formatted_location, location_time
       FROM dispatch_truck_location_history
      WHERE plate = ANY($1::text[])
        AND location_time >= now() - interval '10 minutes'
      ORDER BY plate, location_time ASC`,
    [normalizedPlates]
  );
  return result.rows.reduce((byPlate, row) => {
    if (!byPlate[row.plate]) byPlate[row.plate] = [];
    byPlate[row.plate].push({
      lat: Number(row.latitude),
      lng: Number(row.longitude),
      headingDegrees: Number.isFinite(Number(row.heading_degrees)) ? Number(row.heading_degrees) : null,
      speedMilesPerHour: Number(row.speed_miles_per_hour || 0) || 0,
      formattedLocation: row.formatted_location || "",
      at: row.location_time
    });
    return byPlate;
  }, {});
}

async function estimatedTruckSpeeds(plates = []) {
  const normalizedPlates = [...new Set((plates || []).map((plate) => String(plate || "").trim()).filter(Boolean))];
  if (!normalizedPlates.length) return {};
  const result = await pool.query(
    `SELECT plate, latitude, longitude, location_time
       FROM dispatch_truck_location_history
      WHERE plate = ANY($1::text[])
        AND location_time >= now() - interval '20 seconds'
      ORDER BY plate, location_time ASC`,
    [normalizedPlates]
  );
  const rowsByPlate = result.rows.reduce((byPlate, row) => {
    if (!byPlate[row.plate]) byPlate[row.plate] = [];
    byPlate[row.plate].push(row);
    return byPlate;
  }, {});
  return Object.entries(rowsByPlate).reduce((speeds, [plate, rows]) => {
    if (rows.length < 2) return speeds;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const seconds = (new Date(last.location_time).getTime() - new Date(first.location_time).getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) return speeds;
    const kilometers = coordinateDistanceMeters(first.latitude, first.longitude, last.latitude, last.longitude) / 1000;
    const kmh = kilometers / (seconds / 3600);
    if (Number.isFinite(kmh)) speeds[plate] = kmh;
    return speeds;
  }, {});
}

function localDateDaysAgo(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function validCoordinate(latitude, longitude) {
  if (
    latitude === null
    || latitude === undefined
    || longitude === null
    || longitude === undefined
    || String(latitude).trim() === ""
    || String(longitude).trim() === ""
  ) {
    return false;
  }
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
}

async function geocodeStopAddress(address) {
  const text = String(address || "").trim();
  if (!text || !config.googleMapsApiKey) return null;
  const key = normalizedLocationText(text);
  if (driverGeocodeCache.has(key)) return driverGeocodeCache.get(key);
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", text);
  url.searchParams.set("region", "ca");
  url.searchParams.set("components", "country:CA");
  url.searchParams.set("key", config.googleMapsApiKey);
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), DRIVER_GEOCODE_TIMEOUT_MS);
  timeoutId.unref?.();
  let payload = {};
  try {
    const response = await fetch(url, { signal: timeoutController.signal });
    const responseText = await response.text();
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = {};
      }
    }
  } catch (error) {
    if (timeoutController.signal.aborted) {
      const timeoutError = new Error(
        `Google geocoding timed out after ${Math.round(DRIVER_GEOCODE_TIMEOUT_MS / 1000)} seconds.`
      );
      timeoutError.code = "DRIVER_GEOCODE_TIMEOUT";
      timeoutError.timeoutMs = DRIVER_GEOCODE_TIMEOUT_MS;
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  const location = payload.results?.[0]?.geometry?.location;
  const point = validCoordinate(location?.lat, location?.lng)
    ? { latitude: Number(location.lat), longitude: Number(location.lng), source: "google_geocode" }
    : null;
  driverGeocodeCache.set(key, point);
  return point;
}

async function expectedPointForDriverJob(job) {
  const setup = await readDispatchSetup();
  const ownCandidates = [job?.toLocation, job?.location, job?.address]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const candidate of ownCandidates) {
    const yard = (setup.ownYards || []).find((item) =>
      [item.code, item.name, item.address].some((value) =>
        normalizedLocationText(value) === normalizedLocationText(candidate)
        || dispatchLocationsShareYard(value, candidate)
      )
    );
    if (yard && validCoordinate(yard.lat, yard.lng)) {
      return {
        latitude: Number(yard.lat),
        longitude: Number(yard.lng),
        address: yard.address || yard.name || candidate,
        source: "own_yard"
      };
    }
  }
  const address = job?.stopType === "travel"
    ? job?.toAddress || job?.address
    : job?.address || job?.toAddress || job?.location;
  const geocoded = await geocodeStopAddress(address);
  return geocoded ? { ...geocoded, address } : { address: address || "", source: "unavailable" };
}

async function samsaraLocationForDriverJob(job) {
  const plate = String(job?.truckPlate || "").trim();
  if (!plate) return null;
  const locations = await listSamsaraVehicleLocations({ plates: [plate] });
  const location = locations.find((item) => normalizedPlate(item.plate) === normalizedPlate(plate)) || locations[0] || null;
  if (!location || !validCoordinate(location.latitude, location.longitude)) return null;
  return {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    accuracy: 0,
    plate: location.plate || plate,
    vehicleId: location.vehicleId || "",
    vehicleName: location.vehicleName || "",
    formattedLocation: location.formattedLocation || "",
    locationTime: location.time || "",
    source: "samsara"
  };
}

async function checkDriverJobLocation(job) {
  const expectedAddress = job?.stopType === "travel"
    ? job?.toAddress || job?.address || ""
    : job?.address || job?.toAddress || job?.location || "";
  const [truckLookup, expectedLookup] = await Promise.allSettled([
    samsaraLocationForDriverJob(job),
    expectedPointForDriverJob(job)
  ]);
  const truckLocation = truckLookup.status === "fulfilled" ? truckLookup.value : null;
  const expected = expectedLookup.status === "fulfilled"
    ? expectedLookup.value
    : { address: expectedAddress, source: "unavailable" };
  const lookupErrors = [
    truckLookup.status === "rejected"
      ? `Samsara GPS: ${String(truckLookup.reason?.message || truckLookup.reason || "lookup failed")}`
      : "",
    expectedLookup.status === "rejected"
      ? `Expected stop: ${String(expectedLookup.reason?.message || expectedLookup.reason || "lookup failed")}`
      : ""
  ].filter(Boolean);
  if (lookupErrors.length) {
    return {
      status: "unavailable",
      message: "Location verification service was unavailable. Recheck or confirm override.",
      truckPlate: job?.truckPlate || "",
      expectedAddress: expected?.address || expectedAddress,
      verificationError: lookupErrors.join(" ")
    };
  }
  const latitude = Number(truckLocation?.latitude);
  const longitude = Number(truckLocation?.longitude);
  if (!validCoordinate(latitude, longitude)) {
    return {
      status: "unavailable",
      message: `Samsara truck location was not available for ${job?.truckPlate || "this truck"}.`,
      truckPlate: job?.truckPlate || ""
    };
  }
  if (!validCoordinate(expected.latitude, expected.longitude)) {
    return {
      status: "unavailable",
      message: expected.address
        ? "Expected address could not be geocoded for verification."
        : "Expected stop address is missing.",
      expectedAddress: expected.address || ""
    };
  }
  const distanceMeters = coordinateDistanceMeters(latitude, longitude, expected.latitude, expected.longitude);
  const thresholdMeters = 500;
  const ok = distanceMeters <= thresholdMeters;
  return {
    status: ok ? "ok" : "warning",
    message: ok
      ? `Truck location verified within ${Math.round(distanceMeters)} m.`
      : `Samsara truck GPS is ${Math.round(distanceMeters)} m from the expected stop. Recheck before confirming.`,
    distanceMeters: Math.round(distanceMeters),
    thresholdMeters: Math.round(thresholdMeters),
    expectedAddress: expected.address || "",
    expectedLatitude: expected.latitude,
    expectedLongitude: expected.longitude,
    currentLatitude: latitude,
    currentLongitude: longitude,
    truckPlate: truckLocation.plate || job?.truckPlate || "",
    truckLocationTime: truckLocation.locationTime || "",
    truckFormattedLocation: truckLocation.formattedLocation || "",
    source: truckLocation.source || "samsara",
    expectedSource: expected.source || ""
  };
}

async function completeDriverJobOperationalEffects({
  driverLogin,
  job,
  photoDataUrls = [],
  occurredAt = null,
  offlineTrace = null,
  driverRemark = undefined
} = {}) {
  if (!job?.jobId) throw new Error("Driver job is no longer available.");
  const completion = await withTransaction(async () => {
    const record = await recordDriverJobPhotos(driverLogin, job.jobId, {
      photoDataUrls,
      job,
      occurredAt,
      offlineTrace,
      driverRemark
    });
    let dependencyUpdate = null;
    let completedCustomOrders = [];
    if (job.stopType === "pickup") {
      const transferRefs = (job.dependencyPickupManifests || [])
        .map((entry) => entry.transferOrderRef)
        .filter(Boolean);
      dependencyUpdate = await markDirectDependencyPickupCompleted({
        transferOrderRefs: transferRefs,
        driverJobId: job.jobId
      });
    } else if (job.stopType === "dropoff") {
      const yardReplenishment = await completeYardDependenciesForTransferDrop({
        transferOrderRefs: job.orderRefs || [],
        driverJobId: job.jobId,
        driverLogin,
        planId: job.planId,
        planDate: job.planDate,
        truckPlate: job.truckPlate,
        loadId: job.loadId,
        loadName: job.loadName,
        destinationLocationId: job.destinationLocationId,
        expectedSourceOfflineEventId: offlineTrace?.eventId || ""
      });
      if (yardReplenishment.skipped.length) {
        const conflicts = yardReplenishment.skipped.map((item) => ({
          transferOrderRef: item.transferOrderRef || "",
          reason: item.reason || "yard_dependency_delivery_not_applied"
        }));
        throw Object.assign(
          new Error(
            `The Transfer Order drop evidence needs dependency review: ${
              conflicts.map((item) =>
                `${item.transferOrderRef || "Transfer Order"} (${item.reason})`
              ).join(", ")
            }`
          ),
          {
            status: 409,
            code: "YARD_DEPENDENCY_DELIVERY_REVIEW_REQUIRED",
            conflicts
          }
        );
      }
      const directToCustomer = await completeDirectDependenciesForSalesOrderDrop({
        salesOrderRefs: job.orderRefs || [],
        driverJobId: job.jobId,
        planId: job.planId,
        planDate: job.planDate,
        truckPlate: job.truckPlate,
        loadId: job.loadId,
        loadName: job.loadName
      });
      dependencyUpdate = {
        completed: [
          ...yardReplenishment.completed,
          ...directToCustomer.completed
        ],
        alreadyCompleted: [
          ...yardReplenishment.alreadyCompleted,
          ...directToCustomer.alreadyCompleted
        ],
        skipped: yardReplenishment.skipped,
        yardReplenishment,
        directToCustomer
      };
      completedCustomOrders = await completeDispatchCustomOrders(
        job.orderRefs || [],
        `driver:${driverLogin}`
      );
    }
    return { record, dependencyUpdate, completedCustomOrders };
  });
  let billedSalesOrderPlanCleanup = null;
  let billedSalesOrderPlanCleanupWarning = "";
  if (job.planId) {
    try {
      billedSalesOrderPlanCleanup = await cleanupBilledSalesOrderFamiliesFromDispatchPlan({
        planId: job.planId,
        actor: `driver:${driverLogin}`
      });
      if (billedSalesOrderPlanCleanup.changedPlans.length) {
        emitAppEvent("dispatch.plan.saved", {
          planId: job.planId,
          planDate: job.planDate || "",
          source: "billed-so-driver-completion-cleanup",
          refreshOrderPool: true
        });
      }
    } catch (error) {
      billedSalesOrderPlanCleanupWarning = String(error?.message || error);
      console.error("Billed SO plan cleanup after driver completion failed:", error);
    }
  }
  return {
    ...completion,
    billedSalesOrderPlanCleanup,
    billedSalesOrderPlanCleanupWarning
  };
}

function driverRequestClientVersion(req) {
  return String(req.get?.(DRIVER_PWA_VERSION_HEADER) || DRIVER_PWA_CURRENT_VERSION).trim();
}

async function authorizedDriverDayJobs(req, planDate) {
  const options = {
    date: planDate,
    clientVersion: driverRequestClientVersion(req),
    minimumClientVersion: DRIVER_PWA_MINIMUM_VERSION
  };
  try {
    return {
      allowBin: false,
      boundary: null,
      result: await getDriverDayJobs(req.driverLogin, options)
    };
  } catch (error) {
    if (error?.code !== "MBT_DRIVER_BIN_DISABLED") throw error;
  }
  const boundary = await authorizeMbtDriverBinProjection({
    driverLogin: req.driverLogin,
    planDate
  });
  const result = await getDriverDayJobs(req.driverLogin, { ...options, allowBin: true });
  assertMbtDriverBinProjectionScope(result.jobs, boundary);
  return { allowBin: true, boundary, result };
}

async function authorizedDriverNextJobContext(req, { date = "" } = {}) {
  const options = {
    date,
    clientVersion: driverRequestClientVersion(req),
    minimumClientVersion: DRIVER_PWA_MINIMUM_VERSION
  };
  try {
    return {
      allowBin: false,
      boundary: null,
      context: await getDriverNextJobContext(req.driverLogin, options)
    };
  } catch (error) {
    if (error?.code !== "MBT_DRIVER_BIN_DISABLED") throw error;
  }
  const planDate = normalizePlanDate(date || localDateDaysAgo(0));
  const boundary = await authorizeMbtDriverBinProjection({
    driverLogin: req.driverLogin,
    planDate
  });
  const context = await getDriverNextJobContext(req.driverLogin, { ...options, allowBin: true });
  assertMbtDriverBinProjectionScope(context.jobs, boundary);
  return { allowBin: true, boundary, context };
}

async function applyDriverOfflineEvent({
  event,
  job,
  manifest,
  rebased,
  photoReferences,
  offlineTrace,
  routeJobs = [],
  emissionSource = "offline_sync"
}) {
  const driverLogin = event.driverLogin;
  const mbtApplication = await applyMbtDriverBinOfflineEvent({
    event,
    job,
    manifest,
    photoReferences
  });
  if (mbtApplication) {
    return mbtApplication;
  }
  if (event.eventType === "job_started") {
    if (!job) throw new Error("The job to start is unavailable.");
    if (job.stopType === "pickup" || job.stopType === "dropoff") {
      await reconcileCompletedYardTransfersForSalesOrderStart({
        salesOrderRefs: job.orderRefs || [],
        currentJob: job,
        routeJobs,
        driverLogin,
        event
      });
      const dependencyBlock = await getSalesOrderDependencyExecutionBlock(job.orderRefs || []);
      if (dependencyBlock) throw Object.assign(new Error(dependencyBlock.message), {
        code: "OFFLINE_DEPENDENCY_BLOCKED"
      });
      if (job.stopType === "pickup") {
        const directTransferRefs = (job.dependencyPickupManifests || [])
          .map((entry) => entry.transferOrderRef)
          .filter(Boolean);
        const directPickupBlock = await getDirectPickupDependencyExecutionBlock(directTransferRefs);
        if (directPickupBlock) throw Object.assign(new Error(directPickupBlock.message), {
          code: "OFFLINE_DIRECT_PICKUP_BLOCKED"
        });
      }
    }
    const record = await startDriverJob(driverLogin, job.jobId, {
      job,
      occurredAt: event.occurredAt,
      offlineTrace
    });
    emitAppEvent("driver.job.started", {
      driverLogin,
      eventId: event.eventId,
      source: emissionSource,
      jobId: job.jobId,
      stopType: job.stopType,
      orderRefs: job.orderRefs || [],
      offline: true
    });
    return {
      recordId: record?.id || null,
      samsaraDutyPendingOnline: manifest?.samsaraWorkflowEnabled === true,
      samsaraDutyReconciled: manifest?.samsaraWorkflowEnabled !== true
    };
  }
  if (event.eventType === "job_completed") {
    if (!job) throw new Error("The job to complete is unavailable.");
    const completion = await completeDriverJobOperationalEffects({
      driverLogin,
      job,
      photoDataUrls: photoReferences,
      occurredAt: event.occurredAt,
      offlineTrace,
      driverRemark: event.details?.driverRemark
    });
    emitAppEvent("driver.job.completed", {
      driverLogin,
      eventId: event.eventId,
      source: emissionSource,
      jobId: job.jobId,
      stopType: job.stopType,
      offline: true,
      dependencyUpdate: completion.dependencyUpdate
    });
    if (
      completion.dependencyUpdate
      && (
        Array.isArray(completion.dependencyUpdate)
          ? completion.dependencyUpdate.length
          : completion.dependencyUpdate.completed?.length
      )
    ) {
      emitAppEvent("dispatch.orders.updated", {
        source: "driver-offline-order-dependency",
        refreshOrderPool: true
      });
    }
    if (completion.completedCustomOrders.length) {
      emitAppEvent("dispatch.orders.updated", {
        source: "driver-offline-custom-order",
        change: "custom_order_completed",
        orderIds: completion.completedCustomOrders.map((order) => order.refNumber),
        refreshOrderPool: true
      });
    }
    return {
      recordId: completion.record?.id || null,
      dependencyUpdated: Boolean(completion.dependencyUpdate),
      completedCustomOrderCount: completion.completedCustomOrders.length
    };
  }
  if (event.eventType === "rest_started") {
    const nextJobId = event.details?.nextJobId || "";
    const nextJob = job
      || (manifest?.jobs || []).find((candidate) =>
        String(candidate.jobId) === String(nextJobId)
      )
      || (manifest?.jobs || []).find((candidate) =>
        !candidate.completedAt && candidate.stopType !== "truck_switch"
      );
    if (!nextJob) throw new Error("The next route job for this rest event is unavailable.");
    const rest = await startDriverRest(driverLogin, {
      nextJob,
      restId: event.details?.restId || event.eventId,
      occurredAt: event.occurredAt,
      offlineTrace
    });
    emitAppEvent("driver.rest.started", {
      driverLogin,
      eventId: event.eventId,
      source: emissionSource,
      restId: rest?.restId || event.details?.restId || "",
      nextJobId: nextJob.jobId,
      offline: true
    });
    return { restId: rest?.restId || event.details?.restId || "" };
  }
  if (event.eventType === "rest_ended") {
    const rest = await endDriverRest(driverLogin, {
      restId: event.details?.restId || "",
      occurredAt: event.occurredAt,
      offlineTrace
    });
    if (!rest) throw new Error("The active rest record could not be found.");
    emitAppEvent("driver.rest.ended", {
      driverLogin,
      eventId: event.eventId,
      source: emissionSource,
      restId: rest.restId,
      offline: true
    });
    return { restId: rest.restId };
  }
  if (event.eventType === "truck_switched_physical") {
    if (!job) throw new Error("The truck-switch job is unavailable.");
    const samsaraReconciliationRequired = manifest?.samsaraWorkflowEnabled === true;
    const result = await recordOfflineDriverTruckSwitch(driverLogin, job, {
      occurredAt: event.occurredAt,
      offlineTrace,
      samsaraReconciliationRequired
    });
    await writeDispatchAudit({
      action: samsaraReconciliationRequired
        ? "driver_truck_switch_recorded_offline"
        : "driver_truck_switch_confirmed_samsara_disabled",
      entityType: "driver_job",
      entityId: job.jobId,
      planId: job.planId,
      planDate: job.planDate,
      operatorName: driverLogin,
      source: "driver",
      details: {
        driverLogin,
        fromTruckPlate: job.fromTruckPlate || "",
        toTruckPlate: job.nextTruckPlate || job.truckPlate || "",
        switchYard: job.switchYard || "",
        eventId: event.eventId,
        samsaraReconciliationRequired
      }
    });
    emitAppEvent(
      samsaraReconciliationRequired
        ? "driver.truck.switch.attention"
        : "driver.truck.switched",
      {
        driverLogin,
        eventId: event.eventId,
        source: emissionSource,
        jobId: job.jobId,
        offline: true,
        ...(samsaraReconciliationRequired
          ? { error: "Physical switch recorded offline; Samsara reconciliation is required." }
          : { truckPlate: job.nextTruckPlate || job.truckPlate || "" })
      }
    );
    return {
      recordId: result.record?.id || null,
      samsaraReconciliationRequired
    };
  }
  if (event.eventType === "dvir_captured") {
    emitAppEvent("driver.dvir.pending_online", {
      driverLogin,
      type: event.details?.dvirType || "pre",
      eventId: event.eventId,
      source: emissionSource,
      offline: true
    });
    return {
      pendingOnline: true,
      interactiveSamsaraSubmissionRequired: true,
      dvirType: event.details?.dvirType || "pre",
      photoCount: photoReferences.length,
      rebased: rebased === true
    };
  }
  throw Object.assign(new Error("Unsupported offline driver event."), {
    code: "OFFLINE_EVENT_TYPE_INVALID"
  });
}

async function driverOfflineReviewWithCurrentPlan(eventId) {
  const detail = await getDriverOfflineReview(eventId);
  if (!detail?.case) return null;
  const reviewCase = detail.case;
  const currentPlan = await getDriverDayJobs(reviewCase.driverLogin, {
    date: reviewCase.planDate,
    allowBin: true
  });
  const entries = materializeDriverOfflineJobs(
    currentPlan.jobs || [],
    reviewCase.driverLogin
  );
  const originalJobId = reviewCase.originalJob?.jobId || reviewCase.originalJobId || "";
  const currentEntry = entries.find((entry) =>
    String(entry.snapshot.jobId) === String(originalJobId)
  );
  const manifestEvent = {
    driverLogin: reviewCase.driverLogin,
    jobFingerprint: reviewCase.originalJob?.fingerprint
      || reviewCase.payload?.jobFingerprint
      || "",
    predecessorFingerprint: reviewCase.originalJob?.predecessorFingerprint
      || reviewCase.payload?.predecessorFingerprint
      || ""
  };
  const candidates = findDriverOfflineRebaseCandidates(
    manifestEvent,
    currentPlan.jobs || [],
    reviewCase.driverLogin
  ).map(({ job, ...candidate }) => ({
    ...candidate,
    snapshot: job
  }));
  return {
    case: {
      ...reviewCase,
      currentJob: currentEntry
        ? {
            jobId: currentEntry.snapshot.jobId,
            fingerprint: currentEntry.fingerprint,
            predecessorFingerprint: currentEntry.predecessorFingerprint,
            compatible: currentEntry.fingerprint === manifestEvent.jobFingerprint
              && currentEntry.predecessorFingerprint === manifestEvent.predecessorFingerprint,
            snapshot: currentEntry.snapshot
          }
        : null,
      candidates,
      photos: (reviewCase.photos || []).map((photo) => ({
        ...photo,
        previewUrl: `/api/dispatch/offline-review/${encodeURIComponent(reviewCase.eventId)}/photos/${encodeURIComponent(photo.photoId)}`
      }))
    }
  };
}

async function applyDriverOfflineReviewResolution({ event, action, effectiveJobId }) {
  const detail = await driverOfflineReviewWithCurrentPlan(event.eventId);
  if (!detail?.case) throw Object.assign(new Error("Offline review case was not found."), { status: 404 });
  const currentPlan = await getDriverDayJobs(event.driverLogin, {
    date: event.planDate,
    allowBin: true
  });
  let job = null;
  if (action === "apply_original") {
    job = detail.case.originalJob?.snapshot || null;
  } else if (action === "reattach") {
    const candidate = (detail.case.candidates || []).find((entry) =>
      entry.compatible && String(entry.jobId) === String(effectiveJobId)
    );
    if (!candidate) {
      throw Object.assign(new Error("The selected current stop is not a validated match."), {
        status: 409,
        code: "OFFLINE_REATTACH_TARGET_INVALID"
      });
    }
    job = candidate.snapshot;
  }
  const manifest = await getDriverOfflineManifest(event.manifestId, {
    driverLogin: event.driverLogin,
    deviceId: event.deviceId,
    touch: false
  });
  const photoReferences = (event.photos || [])
    .filter((photo) => photo.durableReceipt)
    .map((photo) => photo.objectReference);
  const requiredPhotoCount = event.eventType === "dvir_captured"
    ? 4
    : event.eventType === "job_completed"
      ? Math.max(0, Number(job?.requiredPhotos || 0))
      : 0;
  if (photoReferences.length < requiredPhotoCount) {
    throw Object.assign(
      new Error(`${requiredPhotoCount} durably received photo${requiredPhotoCount === 1 ? " is" : "s are"} required before applying this event.`),
      { status: 409, code: "OFFLINE_REQUIRED_PHOTOS_MISSING" }
    );
  }
  return applyDriverOfflineEvent({
    event,
    job,
    manifest,
    rebased: action === "reattach" && event.jobId !== effectiveJobId,
    photoReferences,
    routeJobs: currentPlan.jobs || [],
    emissionSource: "offline_review_resolution",
    offlineTrace: {
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      locationStatus: event.locationStatus,
      locationDetails: {
        resolvedByDispatcher: true,
        resolutionAction: action
      }
    }
  });
}

function emitAppEvent(type, payload = {}) {
  afterTransactionCommit(() => {
    const event = {
      id: ++eventSeq,
      type,
      at: new Date().toISOString(),
      payload
    };
    const body = `id: ${event.id}\nevent: app-event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) {
      try {
        client.res.write(body);
      } catch {
        eventClients.delete(client);
      }
    }
  });
}

function updateFulfillmentJob(jobId, patch) {
  const current = fulfillmentJobs.get(jobId) || { id: jobId };
  fulfillmentJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function updateReceivingJob(jobId, patch) {
  const current = receivingJobs.get(jobId) || { id: jobId };
  receivingJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function bearerToken(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.body?.token || req.query.token || "";
}

function operatorId(req) {
  return req.operator?.id || "";
}

function requiredPhotoDataUrls(values, minimum = 2) {
  const photos = Array.isArray(values)
    ? values.filter((value) => {
        const text = String(value || "");
        return text.startsWith("data:image/") || text.startsWith("r2://");
      })
    : [];
  if (photos.length < minimum) {
    const error = new Error(`At least ${minimum} photos are required.`);
    error.status = 400;
    throw error;
  }
  return photos;
}

async function requireRegisteredForegroundDvirEvidence(req, type, photoReferences) {
  const eventId = String(req.body?.eventId || "").trim().toLowerCase();
  if (!eventId) return null;
  const event = await getDriverOfflineEvent(eventId);
  const deviceId = driverDeviceId(req, { required: true });
  const expectedType = type === "post" ? "post" : "pre";
  const compatible = event
    && event.eventType === "dvir_captured"
    && String(event.driverLogin).toLowerCase() === String(req.driverLogin).toLowerCase()
    && String(event.deviceId) === deviceId
    && String(event.manifestId) === String(req.body?.manifestId || "")
    && String(event.details?.dvirType === "post" ? "post" : "pre") === expectedType
    && canonicalDriverForegroundOccurrence(event.occurredAt)
      === canonicalDriverForegroundOccurrence(req.body?.deviceOccurredAt);
  if (!compatible || event.status !== "applied") {
    throw Object.assign(
      new Error(event?.reviewReason || "The registered inspection event is not ready for an online Samsara action."),
      { status: 409, code: "DRIVER_FOREGROUND_DVIR_NOT_READY" }
    );
  }
  const durableReferences = (event.photos || [])
    .filter((photo) => photo.durableReceipt)
    .map((photo) => String(photo.objectReference || ""));
  const submittedReferences = photoReferences.map((reference) => String(reference || ""));
  if (
    durableReferences.length < 4
    || durableReferences.length !== submittedReferences.length
    || new Set(submittedReferences).size !== submittedReferences.length
    || durableReferences.some((reference, index) => reference !== submittedReferences[index])
  ) {
    throw Object.assign(
      new Error("Inspection photos do not match this event's durably verified evidence."),
      { status: 409, code: "DRIVER_FOREGROUND_DVIR_EVIDENCE_MISMATCH" }
    );
  }
  if (
    event.result?.pendingOnline !== true
    && event.result?.samsaraReconciled !== true
  ) {
    throw Object.assign(
      new Error("The inspection event is not pending an online Samsara action."),
      { status: 409, code: "DRIVER_FOREGROUND_DVIR_NOT_READY" }
    );
  }
  return event;
}

function auditOrderId(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : null;
}

const MUTATING_API_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUDIT_SENSITIVE_FIELD = /(password|passcode|token|secret|authorization|cookie|signature|photo|image|base64|data_?url)/i;
const AUDIT_REFERENCE_FIELDS = [
  ["tranid", "tranid"],
  ["vrmaRef", "vrmaRef"],
  ["vrma_ref", "vrmaRef"],
  ["coRef", "coRef"],
  ["co_ref", "coRef"],
  ["orderRef", "orderRef"],
  ["order_ref", "orderRef"],
  ["sourceOrderRef", "sourceOrderRef"],
  ["source_order_ref", "sourceOrderRef"],
  ["receivingOrderId", "receivingOrderId"],
  ["receiving_order_id", "receivingOrderId"],
  ["deliveryOrderId", "deliveryOrderId"],
  ["delivery_order_id", "deliveryOrderId"],
  ["orderId", "orderId"],
  ["order_id", "orderId"]
];

function sanitizeAuditValue(value, key = "", depth = 0) {
  if (AUDIT_SENSITIVE_FIELD.test(String(key || ""))) {
    const count = Array.isArray(value) ? ` (${value.length} values)` : "";
    return `[REDACTED${count}]`;
  }
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) return "[REDACTED IMAGE]";
    return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  }
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 25).map((entry) => sanitizeAuditValue(entry, key, depth + 1));
    if (value.length > 25) items.push(`[${value.length - 25} more values]`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 50);
    const sanitized = Object.fromEntries(entries.map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeAuditValue(entryValue, entryKey, depth + 1)
    ]));
    if (Object.keys(value).length > 50) sanitized._truncated = true;
    return sanitized;
  }
  return String(value);
}

function auditRequestRoute(req) {
  const routePath = typeof req.route?.path === "string" ? req.route.path : req.path;
  return `${req.baseUrl || ""}${routePath || req.path}`;
}

function auditRequestSource(req) {
  return String(req.path || "").split("/").filter(Boolean)[1] || "application";
}

function auditRequestAction(req, route) {
  const slug = String(route || req.path || "api")
    .replace(/^\/api\/?/i, "")
    .replace(/[^a-z0-9]+/gi, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase() || "api";
  return `application.${String(req.method || "write").toLowerCase()}.${slug}`;
}

function auditRequestReferences(req) {
  const references = {};
  const sources = [req.params, req.body, req.body?.audit?.details];
  for (const [inputKey, outputKey] of AUDIT_REFERENCE_FIELDS) {
    for (const source of sources) {
      const value = source?.[inputKey];
      if (value === null || value === undefined || typeof value === "object") continue;
      const text = String(value).trim();
      if (text && references[outputKey] === undefined) references[outputKey] = text;
    }
  }
  const route = auditRequestRoute(req);
  const routeRef = String(req.params?.ref || "").trim();
  if (routeRef && route.includes("vrma-orders")) references.vrmaRef ||= routeRef;
  else if (routeRef) references.orderRef ||= routeRef;
  return references;
}

async function writeFallbackMutationAudit(req, statusCode, context) {
  if (context.semanticAuditPromises?.length) await Promise.allSettled(context.semanticAuditPromises);
  if (context.semanticAuditCount) return;
  const route = auditRequestRoute(req);
  const references = auditRequestReferences(req);
  const actorName = req.operator?.display_name || req.operator?.username || req.driver?.name || req.driver?.login || "";
  const numericOrderId = auditOrderId(references.orderId || req.params?.id || req.body?.orderId || req.body?.order_id);
  const numericLineId = auditOrderId(req.params?.lineId || req.body?.lineId || req.body?.line_id);
  await writeAudit({
    actorType: req.operator ? "operator" : req.driver ? "driver" : req.path.startsWith("/api/webhooks/") ? "system" : "anonymous",
    actorOperatorId: req.operator?.id || null,
    source: auditRequestSource(req),
    action: auditRequestAction(req, route),
    orderId: numericOrderId,
    lineId: numericLineId,
    details: {
      method: req.method,
      route,
      status: statusCode,
      outcome: statusCode >= 400 ? "rejected" : "completed",
      actorName,
      ...references,
      request: sanitizeAuditValue({ params: req.params || {}, query: req.query || {}, body: req.body || {} }),
      ip: req.ip || "",
      userAgent: req.get("user-agent") || ""
    }
  });
}

function publicDriver(driver) {
  if (!driver) return null;
  const samsaraEnabled = driver.samsaraEnabled === true;
  return {
    login: driver.login,
    name: driver.name,
    license: driver.license,
    number: driver.number,
    samsaraEnabled,
    hasSamsaraPrimary: Boolean(String(driver.samsaraPrimaryLogin || "").trim()),
    hasSamsaraSecondary: Boolean(String(driver.samsaraSecondaryLogin || "").trim()),
    samsaraPrimaryUsername: String(driver.samsaraPrimaryLogin || "").trim(),
    samsaraSecondaryUsername: String(driver.samsaraSecondaryLogin || "").trim()
  };
}

function driverSamsaraWorkflowEnabled(driver) {
  return driver?.samsaraEnabled === true;
}

function samsaraUsernameForDriver(driver, account = "primary") {
  return account === "secondary"
    ? String(driver?.samsaraSecondaryLogin || "").trim()
    : String(driver?.samsaraPrimaryLogin || "").trim();
}

function samsaraAccountsForDriver(driver) {
  return {
    enabled: driverSamsaraWorkflowEnabled(driver),
    primaryUsername: samsaraUsernameForDriver(driver, "primary"),
    secondaryUsername: samsaraUsernameForDriver(driver, "secondary")
  };
}

function driverSamsaraDisabledResponse(res) {
  return res.status(409).json({
    code: "DRIVER_SAMSARA_DISABLED",
    error: "Samsara driver workflows are disabled for this driver in Dispatch Setup."
  });
}

function publicSamsaraAuthResult(result = {}, { includeSecret = false } = {}) {
  const data = result.data || {};
  const token = data.token || data.authToken || result.token || result.authToken || "";
  return {
    ok: true,
    code: includeSecret ? result.code || "" : "",
    authToken: includeSecret ? token : "",
    tokenPreview: token ? `${String(token).slice(0, 8)}...${String(token).slice(-4)}` : "",
    expiresAt: data.expiresAt || data.expiresAtTime || result.expiresAt || result.expiresAtTime || "",
    rawKeys: Object.keys(data)
  };
}

function driverToken(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.body?.token || req.query.token || "";
}

function driverDeviceId(req, { required = false, allowBody = true } = {}) {
  const value = String(
    req.get("x-mbbs-driver-device")
    || (allowBody ? req.body?.deviceId : "")
    || ""
  ).trim();
  if (!value && !required) return "";
  return normalizeDriverDeviceId(value);
}

function driverOfflineGrantToken(req) {
  return String(req.get("x-mbbs-offline-grant") || req.body?.offlineSyncGrant || "").trim();
}

const DRIVER_FOREGROUND_EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalDriverForegroundOccurrence(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

async function beginDriverForegroundAction(req, actionType, targetId = "") {
  const eventId = String(req.body?.eventId || "").trim().toLowerCase();
  if (!eventId) return null;
  if (!DRIVER_FOREGROUND_EVENT_ID_PATTERN.test(eventId)) {
    throw Object.assign(new Error("Foreground event ID is invalid."), { status: 400 });
  }
  const deviceId = driverDeviceId(req, { required: true });
  const occurredAtValue = req.body?.deviceOccurredAt ? new Date(req.body.deviceOccurredAt) : null;
  const occurredAt = occurredAtValue && Number.isFinite(occurredAtValue.getTime())
    ? occurredAtValue.toISOString()
    : null;
  if (!occurredAt) {
    throw Object.assign(
      new Error("The device occurrence time is required for a local-first online action."),
      { status: 400, code: "DRIVER_FOREGROUND_OCCURRENCE_REQUIRED" }
    );
  }
  const manifestId = String(req.body?.manifestId || "").trim();
  if (!manifestId) {
    throw Object.assign(
      new Error("The offline route manifest is required for a local-first online action."),
      { status: 400, code: "DRIVER_FOREGROUND_MANIFEST_REQUIRED" }
    );
  }
  const manifest = await getDriverOfflineManifest(manifestId, {
    driverLogin: req.driverLogin,
    deviceId,
    touch: false
  });
  if (!manifest) {
    throw Object.assign(new Error("The offline route manifest was not found."), {
      status: 404,
      code: "DRIVER_FOREGROUND_MANIFEST_NOT_FOUND"
    });
  }
  const manifestJob = targetId && actionType !== "dvir_captured"
    ? (manifest.jobs || []).find((job) => String(job.jobId) === String(targetId))
    : null;
  if (targetId && actionType !== "dvir_captured" && !manifestJob) {
    throw Object.assign(new Error("The action target is not part of this offline route."), {
      status: 409,
      code: "DRIVER_FOREGROUND_TARGET_MISMATCH"
    });
  }
  if (
    req.body?.jobFingerprint
    && String(req.body.jobFingerprint) !== String(manifestJob?.fingerprint || "")
  ) {
    throw Object.assign(new Error("The action job fingerprint does not match its route manifest."), {
      status: 409,
      code: "DRIVER_FOREGROUND_TARGET_MISMATCH"
    });
  }
  if (
    req.body?.predecessorFingerprint
    && String(req.body.predecessorFingerprint) !== String(manifestJob?.predecessorFingerprint || "")
  ) {
    throw Object.assign(new Error("The action predecessor does not match its route manifest."), {
      status: 409,
      code: "DRIVER_FOREGROUND_TARGET_MISMATCH"
    });
  }
  const capturedTruckPlate = String(
    req.body?.truckPlate
    || manifestJob?.truckPlate
    || manifest?.dayState?.truckPlate
    || ""
  ).trim();
  const eventContext = {
    manifestId: manifest.manifestId,
    planId: manifest.planId,
    planDate: manifest.planDate,
    planRevision: Number(manifest.planRevision || 0),
    clientSequence: Number(req.body?.clientSequence || 0),
    jobFingerprint: manifestJob?.fingerprint || "",
    predecessorFingerprint: manifestJob?.predecessorFingerprint || "",
    truckPlate: capturedTruckPlate
  };
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`driver-foreground:${eventId}`]);
    const existing = await query(
      `SELECT *
         FROM driver_foreground_action_receipts
        WHERE event_id = $1::uuid
        FOR UPDATE`,
      [eventId]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (
        String(row.driver_login).toLowerCase() !== String(req.driverLogin).toLowerCase()
        || String(row.device_id) !== deviceId
        || String(row.action_type) !== String(actionType)
        || String(row.target_id || "") !== String(targetId || "")
        || String(row.event_context?.manifestId || "") !== manifest.manifestId
        || canonicalDriverForegroundOccurrence(row.device_occurred_at) !== occurredAt
      ) {
        throw Object.assign(
          new Error("This foreground event ID was already used for a different action."),
          { status: 409, code: "DRIVER_FOREGROUND_IDEMPOTENCY_CONFLICT" }
        );
      }
      if (row.status === "applied") {
        return {
          eventId,
          deviceId,
          driverLogin: req.driverLogin,
          eventContext: row.event_context || eventContext,
          replay: true,
          result: row.result || {}
        };
      }
      throw Object.assign(
        new Error(row.status === "executing"
          ? "The previous online action has an uncertain outcome and requires review."
          : row.error_message || "The previous online action failed."),
        {
          status: 409,
          code: row.status === "executing"
            ? "DRIVER_FOREGROUND_OUTCOME_UNCERTAIN"
            : row.error_code || "DRIVER_FOREGROUND_ACTION_FAILED"
        }
      );
    }
    const manifestExpiry = new Date(manifest.expiresAt).getTime();
    if (
      !Number.isFinite(manifestExpiry)
      || Date.now() >= manifestExpiry
      || new Date(occurredAt).getTime() > manifestExpiry
    ) {
      throw Object.assign(
        new Error("This offline route has expired. Reconnect and download the current route before recording another action."),
        { status: 409, code: "DRIVER_FOREGROUND_MANIFEST_EXPIRED" }
      );
    }
    await query(
      `INSERT INTO driver_foreground_action_receipts (
         event_id, driver_login, device_id, action_type, target_id,
         event_context, device_occurred_at, status
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, 'executing')`,
      [
        eventId,
        req.driverLogin,
        deviceId,
        actionType,
        String(targetId || ""),
        JSON.stringify(eventContext),
        occurredAt
      ]
    );
    return {
      eventId,
      deviceId,
      driverLogin: req.driverLogin,
      eventContext,
      replay: false
    };
  });
}

async function runDriverForegroundAction(receipt, callback) {
  if (!receipt) return callback();
  if (receipt.replay) return receipt.result;
  try {
    return await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      await query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(receipt.driverLogin).toLowerCase(), String(receipt.eventContext.planDate).slice(0, 10)]
      );
      const planResult = await query(
        `SELECT status, revision, plan_date::text AS plan_date
           FROM dispatch_plans
          WHERE id = $1
          LIMIT 1`,
        [receipt.eventContext.planId]
      );
      const plan = planResult.rows[0];
      if (
        !plan
        || plan.status !== "confirmed"
        || String(plan.plan_date) !== String(receipt.eventContext.planDate)
        || Number(plan.revision || 0) !== Number(receipt.eventContext.planRevision || 0)
      ) {
        throw Object.assign(
          new Error("The dispatch plan changed before the online action could be applied."),
          { status: 409, code: "DRIVER_FOREGROUND_PLAN_CHANGED" }
        );
      }
      const result = await callback();
      const updated = await query(
        `UPDATE driver_foreground_action_receipts
            SET status = 'applied',
                result = $2::jsonb,
                completed_at = now(),
                updated_at = now()
          WHERE event_id = $1::uuid
            AND status = 'executing'
          RETURNING event_id`,
        [receipt.eventId, JSON.stringify(result || {})]
      );
      if (!updated.rowCount) {
        throw Object.assign(new Error("Foreground action receipt changed while applying."), {
          status: 409,
          code: "DRIVER_FOREGROUND_STATE_CONFLICT"
        });
      }
      return result;
    });
  } catch (error) {
    await query(
      `UPDATE driver_foreground_action_receipts
          SET status = 'failed',
              error_code = $2,
              error_message = $3,
              completed_at = now(),
              updated_at = now()
        WHERE event_id = $1::uuid
          AND status = 'executing'`,
      [
        receipt.eventId,
        String(error?.code || "DRIVER_FOREGROUND_ACTION_FAILED").slice(0, 160),
        String(error?.message || error || "Foreground action failed.").slice(0, 2000)
      ]
    ).catch(() => null);
    throw Object.assign(
      new Error("The online action did not finish cleanly. Its saved event must synchronize for review before it is retried."),
      {
        status: 409,
        code: "DRIVER_FOREGROUND_OUTCOME_UNCERTAIN",
        cause: error
      }
    );
  }
}

async function requireDriver(req, res, next) {
  try {
    const token = driverToken(req);
    const session = await getDriverSession(token);
    if (!session) return res.status(401).json({ error: "Driver login required" });
    const driver = await getDispatchDriverByLogin(session.driverLogin);
    if (!driver) {
      await revokeDriverSession(token);
      return res.status(401).json({ error: "Driver login required" });
    }
    req.driver = driver;
    req.driverLogin = session.driverLogin;
    req.driverSession = session;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireDriverOrOfflineGrant(req, res, next) {
  try {
    const token = driverToken(req);
    const session = token ? await getDriverSession(token) : null;
    if (session) {
      const driver = await getDispatchDriverByLogin(session.driverLogin);
      if (driver) {
        req.driver = driver;
        req.driverLogin = session.driverLogin;
        req.driverSession = session;
        return next();
      }
      await revokeDriverSession(token);
    }
    const manifestId = req.body?.manifestId || req.query?.manifestId || "";
    const deviceId = driverDeviceId(req, { required: true });
    const authorization = await authorizeDriverOfflineSync({
      manifestId,
      deviceId,
      offlineGrant: driverOfflineGrantToken(req)
    });
    if (!authorization) {
      return res.status(401).json({
        code: "DRIVER_OFFLINE_AUTH_REQUIRED",
        error: "Driver login or a valid offline-sync grant is required."
      });
    }
    req.driverLogin = authorization.driverLogin;
    req.driverOfflineAuthorization = authorization;
    req.driver = await getDispatchDriverByLogin(authorization.driverLogin);
    if (!req.driver) {
      await revokeDriverOfflineGrants({
        driverLogin: authorization.driverLogin,
        deviceId
      }).catch(() => null);
      return res.status(401).json({
        code: "DRIVER_OFFLINE_AUTH_REQUIRED",
        error: "This driver account is no longer active. Sign in again before synchronizing."
      });
    }
    return next();
  } catch (error) {
    next(error);
  }
}

async function photoPreviewViewer(req) {
  const token = bearerToken(req);
  const operator = await getOperatorByToken(token);
  if (operator) {
    return {
      id: operator.id,
      username: operator.username,
      role: operator.role,
      roles: operator.roles,
      yardLocationIds: operator.yardLocationIds,
      source: operatorHasAnyRole(operator, ["dispatcher", "admin"]) ? "dispatch" : "operator"
    };
  }
  const session = await getDriverSession(token);
  if (session) {
    return {
      id: session.driverLogin,
      login: session.driverLogin,
      role: "driver",
      source: "driver"
    };
  }
  return null;
}

async function requirePhotoPreviewViewer(req, res, next) {
  try {
    const viewer = await photoPreviewViewer(req);
    if (!viewer) return res.status(401).json({ error: "Login required" });
    req.photoViewer = viewer;
    next();
  } catch (error) {
    next(error);
  }
}

function returnPhotoActorId(value) {
  const key = String(value || "").replace(/^r2:\/\//, "").trim();
  const parts = key.split("/");
  if (parts[0] !== "operator" || parts[1] !== "operator-return-photo") return "";
  return parts[5] || "";
}

async function assertReturnPhotoPreviewAccess(viewer, value) {
  const photoActorId = returnPhotoActorId(value);
  if (!photoActorId) return;
  if (operatorHasAnyRole(viewer, ["admin"])) return;

  const roles = new Set(normalizedOperatorRoles(viewer));
  if ((roles.has("operator") || roles.has("yard_manager")) && photoActorId === String(viewer.id || "")) {
    return;
  }
  if (viewer.role === "driver") {
    throw Object.assign(new Error("This return photo is outside your access."), { status: 403 });
  }

  const reference = String(value || "").startsWith("r2://")
    ? String(value).trim()
    : `r2://${String(value || "").trim()}`;
  const matches = await query(
    `SELECT 'record' AS source,
            r.operator_id,
            r.receiving_location_id,
            COALESCE(r.ordering_location_id, r.receiving_location_id) AS sales_location_id
       FROM return_photos p
       INNER JOIN return_records r ON r.id = p.return_record_id
      WHERE p.photo_reference = $1
      UNION ALL
     SELECT 'draft' AS source,
            d.operator_id,
            d.receiving_location_id,
            NULL::bigint AS sales_location_id
       FROM return_drafts d
      WHERE d.expires_at > now()
        AND (
          COALESCE(d.payload->'photos', '[]'::jsonb) @> jsonb_build_array($1::text)
          OR COALESCE(d.payload->'palletPhotos', d.payload->'pallet_photos', '[]'::jsonb)
            @> jsonb_build_array($1::text)
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(d.payload->'lines') = 'array' THEN d.payload->'lines'
                  ELSE '[]'::jsonb
                END
              ) draft_line
             WHERE COALESCE(draft_line->'photos', '[]'::jsonb) @> jsonb_build_array($1::text)
          )
        )`,
    [reference]
  );

  if (roles.has("yard_manager")) {
    const allowed = new Set(returnControlYardLocationIds(viewer));
    if (matches.rows.some((row) => allowed.has(Number(row.receiving_location_id)))) return;
  }
  if (roles.has("sales")) {
    const allowed = new Set(operatorSalesYardLocationIds(viewer));
    if (matches.rows.some((row) =>
      row.source === "record" && allowed.has(Number(row.sales_location_id)))) return;
  }
  throw Object.assign(new Error("This return photo is outside your assigned records or yards."), { status: 403 });
}

async function verifyDriverOfflinePhotoObject(photo, actor) {
  if (!photo?.objectReference) throw new Error("Uploaded photo reference is missing.");
  const ticket = createPhotoReadToken({
    actor: actor || { id: "driver-offline-sync", role: "system" },
    key: photo.objectReference
  });
  const response = await fetch(ticket.objectUrl, {
    headers: { Authorization: `Bearer ${ticket.token}` }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(text || "Uploaded photo could not be read back from durable storage."), {
      status: 409,
      code: "OFFLINE_PHOTO_READBACK_FAILED"
    });
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 2 * 1024 * 1024) {
    throw Object.assign(new Error("Uploaded offline photo exceeds 2 MB."), {
      status: 409,
      code: "OFFLINE_PHOTO_TOO_LARGE"
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) {
    throw Object.assign(new Error("Uploaded offline photo exceeds 2 MB."), {
      status: 409,
      code: "OFFLINE_PHOTO_TOO_LARGE"
    });
  }
  const registeredBytes = Number(photo.byteSize);
  if (bytes.length !== registeredBytes) {
    throw Object.assign(
      new Error(`Uploaded photo contains ${bytes.length} byte${bytes.length === 1 ? "" : "s"}; the registered evidence requires ${registeredBytes} bytes.`),
      { status: 409, code: "OFFLINE_PHOTO_SIZE_MISMATCH" }
    );
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== photo.sha256) {
    throw Object.assign(new Error("Uploaded photo bytes do not match the locally registered evidence."), {
      status: 409,
      code: "OFFLINE_PHOTO_HASH_MISMATCH"
    });
  }
  if (!isJpegEvidenceBytes(bytes)) {
    throw Object.assign(new Error("Uploaded offline evidence is not a valid JPEG image."), {
      status: 409,
      code: "OFFLINE_PHOTO_JPEG_INVALID"
    });
  }
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && !["image/jpeg", "image/jpg", "application/octet-stream"].includes(contentType)) {
    throw Object.assign(new Error("Uploaded offline evidence is not a JPEG image."), {
      status: 409,
      code: "OFFLINE_PHOTO_TYPE_MISMATCH"
    });
  }
  return {
    verifiedByteSize: bytes.length,
    verifiedSha256: sha256,
    receipt: {
      provider: "r2_worker",
      objectReference: photo.objectReference,
      contentType: contentType || "image/jpeg",
      etag: response.headers.get("etag") || "",
      verifiedAt: new Date().toISOString()
    }
  };
}

async function requireOperator(req, res, next) {
  try {
    const operator = await getOperatorByToken(bearerToken(req));
    if (!operator) {
      res.setHeader("cache-control", "no-store");
      return res.status(401).json({ error: "Login required" });
    }
    req.operator = operator;
    next();
  } catch (error) {
    next(error);
  }
}

function publicSalesOperator() {
  return {
    id: null,
    username: "public-sales",
    display_name: "Public Sales",
    role: "sales",
    roles: ["sales"],
    yardLocationIds: SALES_YARDS.map((yard) => yard.locationId),
    publicSales: true
  };
}

const SALES_PRINT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const SALES_PRINT_PREVIEW_LIMIT = 30;
const salesPrintPreviews = new Map();

function pruneSalesPrintPreviews() {
  const now = Date.now();
  for (const [token, preview] of salesPrintPreviews) {
    if (preview.expiresAt <= now) salesPrintPreviews.delete(token);
  }
}

function storeSalesPrintPreview({ orderId, lineLocationId, document }) {
  pruneSalesPrintPreviews();
  while (salesPrintPreviews.size >= SALES_PRINT_PREVIEW_LIMIT) {
    salesPrintPreviews.delete(salesPrintPreviews.keys().next().value);
  }
  const token = crypto.randomUUID();
  salesPrintPreviews.set(token, {
    orderId: String(orderId),
    lineLocationId: Number(lineLocationId),
    document: {
      buffer: document.buffer,
      contentType: document.contentType,
      filename: document.filename,
      locationApplied: document.locationApplied
    },
    expiresAt: Date.now() + SALES_PRINT_PREVIEW_TTL_MS
  });
  return token;
}

function getSalesPrintPreview(token, { orderId, lineLocationId }) {
  pruneSalesPrintPreviews();
  const key = String(token || "").trim();
  const preview = salesPrintPreviews.get(key);
  if (!preview
      || preview.orderId !== String(orderId)
      || preview.lineLocationId !== Number(lineLocationId)) {
    throw Object.assign(new Error("This picking-ticket preview expired. Close it and preview the Sales Order again."), { status: 409 });
  }
  return preview.document;
}

async function requireOperatorOrPublicSalesRead(req, res, next) {
  try {
    const publicSalesRequest = req.method === "GET"
      && req.get("x-mbbs-sales-public") === "1"
      && await isPublicSalesAccessEnabled();
    if (publicSalesRequest) {
      req.operator = publicSalesOperator();
      req.publicSalesAccess = true;
      return next();
    }
    return requireOperator(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function requireSalesOperator(req, res, next) {
  try {
    if (!req.get("authorization") && await isPublicSalesAccessEnabled()) {
      req.operator = publicSalesOperator();
      req.publicSalesAccess = true;
      return next();
    }
    return requireOperator(req, res, next);
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!operatorHasAnyRole(req.operator, ["admin"])) return sendRoleForbidden(res, req.operator, "Admin account required");
  next();
}

function requireDispatcher(req, res, next) {
  if (!operatorHasAnyRole(req.operator, ["dispatcher", "admin"])) {
    return sendRoleForbidden(res, req.operator, "Dispatcher account required");
  }
  next();
}

function roleHomeRoute(operator) {
  return operatorHomeRoute(operator);
}

function sendRoleForbidden(res, operator, message) {
  res.setHeader("cache-control", "no-store");
  return res.status(403).json({ error: message, redirect: roleHomeRoute(operator) });
}

function requireControlAccess(req, res, next) {
  if (!operatorHasAnyRole(req.operator, ["admin", "yard_manager"])) {
    return sendRoleForbidden(res, req.operator, "Yard Manager account required");
  }
  next();
}

function requireOperatorAccess(req, res, next) {
  if (!operatorHasAnyRole(req.operator, ["admin", "operator", "yard_manager"])) {
    return sendRoleForbidden(res, req.operator, "Operator account required");
  }
  next();
}

function returnControlYardLocationIds(operator) {
  if (operatorHasAnyRole(operator, ["admin"])) return null;
  const allowed = (operator?.yardLocationIds || [])
    .map(Number)
    .filter((value) => [1, 28, 15, 26].includes(value));
  // An empty manager assignment must never degrade to unrestricted access.
  return allowed.length ? allowed : [-1];
}

function assertReturnControlYard(operator, locationId) {
  const allowed = returnControlYardLocationIds(operator);
  if (allowed && !allowed.includes(Number(locationId))) {
    throw Object.assign(new Error("This return yard is outside your assigned yards."), { status: 403 });
  }
}

function assertReturnOperatorYard(operator, locationId) {
  if (operatorHasAnyRole(operator, ["admin"]) || !operatorHasAnyRole(operator, ["yard_manager"])) return;
  if (!locationId) {
    throw Object.assign(new Error("Select an assigned receiving yard."), { status: 400 });
  }
  assertReturnControlYard(operator, locationId);
}

const OPERATOR_RETURN_PRIVATE_KEYS = new Set([
  "actualcredit",
  "balancesnapshot",
  "currency",
  "customersnapshot",
  "estimatedcredit",
  "externalid",
  "externalids",
  "foreignamount",
  "netsuitelastsyncedat",
  "netsuitelinesnapshot",
  "netsuiteorderlinesnapshot",
  "netsuiteorderline",
  "netsuitereturntransactions",
  "netsuitesnapshot",
  "netsuitestage",
  "netsuitesyncattempts",
  "netsuitesyncerror",
  "netsuitetransactionid",
  "netsuitetransactionref",
  "netsuitetransactionstatus",
  "observedstockexternalids",
  "observedstocktransactionids",
  "rate",
  "raw",
  "sourcelinesnapshot",
  "sourceordersnapshot",
  "syncevents",
  "transactionids"
]);

function operatorSafeReturnPayload(value) {
  if (Array.isArray(value)) return value.map(operatorSafeReturnPayload);
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll("_", "");
    if (OPERATOR_RETURN_PRIVATE_KEYS.has(normalizedKey)) continue;
    safe[key] = operatorSafeReturnPayload(child);
  }
  return safe;
}

function returnListFilters(req, extra = {}) {
  const type = String(req.query.type || req.query.recordType || "").trim().toLowerCase();
  const requestedStatus = String(req.query.status || "").trim().toLowerCase();
  const mapped = type === "normal_stock"
    ? { recordType: "stock", stockReturnType: "normal" }
    : type === "quality_stock"
      ? { recordType: "stock", stockReturnType: "quality" }
      : type === "pallet"
        ? { recordType: "pallet" }
        : type === "stock"
          ? { recordType: "stock" }
          : {};
  return {
    ...mapped,
    status: requestedStatus === "approved"
      ? "accepted"
      : ["sync_failed", "synced"].includes(requestedStatus)
        ? ""
        : requestedStatus,
    netSuiteSyncStatus: requestedStatus === "sync_failed"
      ? ["failed"]
      : requestedStatus === "synced"
        ? ["succeeded", "manual_linked"]
        : null,
    receivingLocationId: req.query.receivingLocationId || req.query.yardLocationId || req.query.yard || "",
    from: req.query.from || "",
    to: req.query.to || "",
    search: req.query.search || "",
    limit: req.query.limit,
    offset: req.query.offset,
    ...extra
  };
}

function dispatchEditLeaseInput(req, planDate = "") {
  return {
    planDate: planDate || req.body?.planDate || req.body?.date || req.query?.planDate || req.query?.date || "",
    operatorId: req.operator?.id || "",
    operatorName: req.operator?.display_name || req.operator?.username || "",
    sessionId: req.body?.sessionId || req.body?.audit?.sessionId || req.query?.sessionId || "",
    token: req.body?.editLeaseToken || req.get("x-dispatch-edit-lease") || req.query?.editLeaseToken || ""
  };
}

async function requireDispatchPlanEditLease(req, planDate = "") {
  const input = dispatchEditLeaseInput(req, planDate);
  if (process.env.MBBS_ENABLE_ROLLBACK_TESTS === "1" && req.get("x-mbbs-rollback-test") === "1" && !input.token) {
    input.planDate = input.planDate || "2099-12-31";
    const acquired = await acquireDispatchPlanEditLease(input);
    input.token = acquired.token;
  }
  return assertDispatchPlanEditLease(input);
}

async function requireDispatchV2PlanEditLease(req, planDate = "") {
  const input = dispatchEditLeaseInput(req, planDate);
  const lease = await getDispatchPlanEditLease(input.planDate);
  if (
    input.token
    && lease?.active
    && String(lease.operatorId || "") === String(req.operator?.id || "")
  ) {
    return assertDispatchPlanEditLease({ ...input, sessionId: lease.sessionId });
  }
  return assertDispatchPlanEditLease(input);
}

function sendDispatchPlanEditLeaseError(res, error) {
  return res.status(error.status || 409).json({
    error: error.message,
    code: error.code || "DISPATCH_PLAN_EDIT_LEASE_REQUIRED",
    lease: error.lease || null
  });
}

function normalizedOperatorRole(operator) {
  return String(operator?.role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function normalizedOperatorRoles(operator) {
  return [...new Set([
    ...(Array.isArray(operator?.roles) ? operator.roles : []),
    operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean))];
}

function operatorHasAnyRole(operator, expectedRoles = []) {
  const granted = new Set(normalizedOperatorRoles(operator));
  return expectedRoles.some((role) => granted.has(String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")));
}

function requireDispatchAccess(req, res, next) {
  if (String(req.path || "").startsWith("/scm")) {
    if (operatorHasAnyRole(req.operator, ["admin", "dispatcher", "scm", "scm_staff"])) return next();
    return sendRoleForbidden(res, req.operator, "SCM account required");
  }
  if (req.method === "GET" && operatorHasAnyRole(req.operator, ["sales"])) return next();
  if (!operatorHasAnyRole(req.operator, ["dispatcher", "admin"])) {
    return sendRoleForbidden(res, req.operator, "Dispatcher account required");
  }
  next();
}

function requireScmAccess(req, res, next) {
  if (operatorHasAnyRole(req.operator, ["admin", "dispatcher", "scm", "scm_staff"])) return next();
  if (operatorHasAnyRole(req.operator, ["yard_manager"])) {
    const requestPath = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
    const yardManagerReadPaths = new Set([
      "/api/scm/schedule",
      "/api/scm/schedule-formatting",
      "/api/scm/view-presets"
    ]);
    const schedulePreferencePath = /^\/api\/scm\/schedule-preferences\/scm$/i.test(requestPath);
    if ((req.method === "GET" && (yardManagerReadPaths.has(requestPath) || schedulePreferencePath))
        || (req.method === "PUT" && schedulePreferencePath)) {
      return next();
    }
  }
  return sendRoleForbidden(res, req.operator, "SCM account required");
}

function requireSalesAccess(req, res, next) {
  if (operatorHasAnyRole(req.operator, ["admin", "sales"])) return next();
  return sendRoleForbidden(res, req.operator, "Sales account required");
}

function requirePrivateSalesRecordAccess(req, res, next) {
  if (req.publicSalesAccess || req.operator?.publicSales || !req.operator?.id) {
    return res.status(403).json({ error: "Staff Sales login required.", redirect: "/sales" });
  }
  next();
}

function operatorSalesYardLocationIds(operator) {
  if (operatorHasAnyRole(operator, ["admin"])) return SALES_YARDS.map((yard) => yard.locationId);
  return normalizeSalesYardLocationIds(operator?.yardLocationIds || []);
}

function movementAllowedYardLocationIds(req) {
  return operatorHasAnyRole(req.operator, ["sales"])
    ? operatorSalesYardLocationIds(req.operator)
    : undefined;
}

function operatorSalesYardCodes(operator) {
  const allowed = new Set(operatorSalesYardLocationIds(operator));
  return SALES_YARDS.filter((yard) => allowed.has(yard.locationId)).map((yard) => yard.yardCode);
}

function salesPrintDestinationLocationIds() {
  return SALES_YARDS.map((yard) => yard.locationId);
}

function requireSalesPrintDestination(value) {
  const locationId = Number(value);
  if (!salesPrintDestinationLocationIds().includes(locationId)) {
    throw Object.assign(new Error("Select a valid Sales printer destination."), { status: 400 });
  }
  return locationId;
}

function optionalSalesPrintCompanyName(value) {
  const companyName = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (companyName.length > 120) {
    throw Object.assign(new Error("Company name must be 120 characters or fewer."), { status: 400 });
  }
  return companyName;
}

function normalizedSalesPrintIp(value) {
  const ip = String(value || "")
    .trim()
    .replace(/^::ffff:/i, "");
  return isIP(ip) ? ip.slice(0, 128) : "";
}

function salesPrintRequestIp(req) {
  return normalizedSalesPrintIp(req.get?.("cf-connecting-ip"))
    || normalizedSalesPrintIp(req.ip)
    || normalizedSalesPrintIp(req.socket?.remoteAddress);
}

async function salesOrderPrintContext(req, lineLocationValue) {
  const hasRequestedLocation = lineLocationValue !== undefined
    && lineLocationValue !== null
    && String(lineLocationValue).trim() !== "";
  const requestedLocationId = Number(lineLocationValue);
  if (hasRequestedLocation && (!Number.isInteger(requestedLocationId) || requestedLocationId <= 0)) {
    throw Object.assign(new Error("This Sales Order does not have a valid inventory line yard."), { status: 400 });
  }
  const candidate = await getSalesOrderPrintCandidate({
    orderId: req.params.id,
    allowedOrderingLocationIds: operatorSalesYardLocationIds(req.operator)
  });
  if (candidate.lineYards.length !== 1) {
    const message = candidate.lineYards.length
      ? "This Sales Order has multiple inventory line yards. Printing is blocked until its outbound inventory yard is corrected."
      : "This Sales Order does not have an inventory line yard for printing.";
    throw Object.assign(new Error(message), { status: 409 });
  }
  const lineYard = candidate.lineYards[0];
  const lineLocationId = Number(lineYard.locationId);
  if (hasRequestedLocation && requestedLocationId !== lineLocationId) {
    throw Object.assign(new Error("The print destination is fixed to this Sales Order's inventory line yard."), { status: 400 });
  }
  const printerLocationId = requireSalesPrintDestination(lineYard.printerLocationId);
  const printer = (await listYardPrinters())
    .find((item) => Number(item.locationId) === printerLocationId);
  if (!printer) {
    throw Object.assign(new Error("The selected Sales printer destination was not found."), { status: 404 });
  }
  return { candidate, lineYard, lineLocationId, printer, printerLocationId };
}

function requireSmartScmAccess(req, res, next) {
  if (operatorHasAnyRole(req.operator, ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"])) return next();
  return sendRoleForbidden(res, req.operator, "Smart SCM access required");
}

function requireSmartScmWriteAccess(req, res, next) {
  if (operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) return next();
  return sendRoleForbidden(res, req.operator, "SCM edit access required");
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const result = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    timeout
  ]);
  clearTimeout(timer);
  return result;
}

async function readDispatchSetup({ includeInactive = false } = {}) {
  const text = await fs.readFile(dispatchSetupPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const saved = text ? JSON.parse(text) : {};
  let [allDrivers, allTrucks] = await Promise.all([
    listDispatchDrivers({ activeOnly: false }),
    listDispatchTrucks({ activeOnly: false })
  ]);
  const seedDrivers = Array.isArray(saved.drivers) ? saved.drivers : defaultDispatchSetup.drivers;
  const seedTrucks = Array.isArray(saved.trucks) ? saved.trucks : defaultDispatchSetup.trucks;
  if ((!allDrivers.length && seedDrivers.length) || (!allTrucks.length && seedTrucks.length)) {
    await ensureDispatchFleetSetup({ drivers: seedDrivers, trucks: seedTrucks });
    [allDrivers, allTrucks] = await Promise.all([
      listDispatchDrivers({ activeOnly: false }),
      listDispatchTrucks({ activeOnly: false })
    ]);
  }
  const drivers = includeInactive ? allDrivers : allDrivers.filter((driver) => driver.active !== false);
  const trucks = includeInactive ? allTrucks : allTrucks.filter((truck) => truck.active !== false);
  return {
    drivers,
    trucks,
    ownYards: Array.isArray(saved.ownYards) ? saved.ownYards : defaultDispatchSetup.ownYards,
    sync: normalizeSyncSettings(saved.sync),
    samsara: {
      ...defaultDispatchSetup.samsara,
      ...(saved.samsara || {})
    },
    planning: {
      ...defaultDispatchSetup.planning,
      ...(saved.planning || {}),
      truckSwitchMinutes: Math.max(0, Math.round(Number.isFinite(Number(saved.planning?.truckSwitchMinutes))
        ? Number(saved.planning.truckSwitchMinutes)
        : defaultDispatchSetup.planning.truckSwitchMinutes))
    }
  };
}

function normalizeSyncSettings(sync = {}) {
  const cleanSync = { ...(sync || {}) };
  delete cleanSync.salesOrderCreatedFrom;
  const mode = cleanSync.mode === "auto" ? "auto" : "manual";
  const intervalSeconds = Number(cleanSync.intervalSeconds ?? defaultDispatchSetup.sync.intervalSeconds);
  const maxRunSeconds = Number(cleanSync.maxRunSeconds ?? defaultDispatchSetup.sync.maxRunSeconds);
  return {
    ...defaultDispatchSetup.sync,
    ...cleanSync,
    mode,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds >= 30 ? Math.round(intervalSeconds) : defaultDispatchSetup.sync.intervalSeconds,
    maxRunSeconds: Number.isFinite(maxRunSeconds) && maxRunSeconds >= 60 ? Math.round(maxRunSeconds) : defaultDispatchSetup.sync.maxRunSeconds,
    running: Boolean(sync.running)
  };
}

function validateDispatchSetupDrivers(drivers = []) {
  const seen = new Map();
  for (const driver of drivers || []) {
    const login = String(driver?.login || "").trim();
    if (!login) continue;
    const key = login.toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      const error = new Error(`Driver login must be unique. "${login}" is used by both ${previous} and ${driver?.name || login}.`);
      error.status = 400;
      throw error;
    }
    seen.set(key, driver?.name || login);
  }
}

async function writeDispatchSetup(patch = {}, { includeInactive = false } = {}) {
  const current = await readDispatchSetup({ includeInactive });
  const currentDriversById = new Map((current.drivers || []).map((driver) => [String(driver.id || ""), driver]).filter(([id]) => id));
  const currentDriversByLogin = new Map((current.drivers || []).map((driver) => [String(driver.login || "").trim().toLowerCase(), driver]).filter(([login]) => login));
  const currentTrucksById = new Map((current.trucks || []).map((truck) => [String(truck.id || ""), truck]).filter(([id]) => id));
  const currentTrucksByPlate = new Map((current.trucks || []).map((truck) => [normalizedPlate(truck.plate), truck]).filter(([plate]) => plate));
  const requestedDrivers = Array.isArray(patch.drivers)
    ? patch.drivers.map((driver) => {
        const existing = currentDriversById.get(String(driver?.id || ""))
          || currentDriversByLogin.get(String(driver?.login || "").trim().toLowerCase());
        const hasSamsaraSetting = Object.hasOwn(driver || {}, "connectSamsara")
          || Object.hasOwn(driver || {}, "samsaraEnabled");
        return {
          ...driver,
          samsaraEnabled: hasSamsaraSetting
            ? driver?.connectSamsara === true || driver?.samsaraEnabled === true
            : existing?.samsaraEnabled === true,
          active: existing ? existing.active !== false : true
        };
      })
    : current.drivers;
  const requestedTrucks = Array.isArray(patch.trucks)
    ? patch.trucks.map((truck) => {
        const existing = currentTrucksById.get(String(truck?.id || ""))
          || currentTrucksByPlate.get(normalizedPlate(truck?.plate));
        return { ...truck, active: existing ? existing.active !== false : true };
      })
    : current.trucks;
  validateDispatchSetupDrivers(requestedDrivers);
  const driverRenames = requestedDrivers.map((driver) => {
    const existing = currentDriversById.get(String(driver?.id || ""))
      || currentDriversByLogin.get(String(driver?.login || "").trim().toLowerCase());
    return existing && String(existing.name || "").trim() !== String(driver?.name || "").trim()
      ? {
          id: existing.id,
          login: existing.login,
          previousName: existing.name,
          nextName: driver.name
        }
      : null;
  }).filter(Boolean);
  if (driverRenames.length) {
    const futurePlans = await query(
      `SELECT p.id, p.plan_date::text, p.status, s.trucks
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.plan_date >= $1::date
          AND lower(p.status) NOT IN ('cancelled', 'canceled', 'archived')
        ORDER BY p.plan_date, p.id`,
      [localDateDaysAgo(0)]
    );
    const renameConflicts = dispatchLegacyDriverRenameConflicts(futurePlans.rows, driverRenames);
    if (renameConflicts.length) {
      const error = new Error(renameConflicts[0].message);
      error.status = 409;
      error.code = "DISPATCH_DRIVER_LEGACY_NAME_IN_USE";
      error.conflicts = renameConflicts;
      throw error;
    }
  }
  const fleet = Array.isArray(patch.drivers) || Array.isArray(patch.trucks)
    ? await replaceDispatchFleetSetup(
        { drivers: requestedDrivers, trucks: requestedTrucks },
        { activeOnly: !includeInactive, deactivateMissing: false }
      )
    : { drivers: current.drivers, trucks: current.trucks };
  const configPayload = {
    ownYards: Array.isArray(patch.ownYards) ? patch.ownYards : current.ownYards,
    sync: patch.sync ? normalizeSyncSettings({ ...current.sync, ...patch.sync }) : current.sync,
    samsara: patch.samsara ? { ...current.samsara, ...patch.samsara } : current.samsara,
    planning: patch.planning
      ? {
          ...current.planning,
          ...patch.planning,
          truckSwitchMinutes: Math.max(0, Math.round(Number.isFinite(Number(patch.planning.truckSwitchMinutes))
            ? Number(patch.planning.truckSwitchMinutes)
            : Number(current.planning?.truckSwitchMinutes ?? 10)))
        }
      : current.planning
  };
  const payload = {
    ...configPayload,
    drivers: fleet.drivers,
    trucks: fleet.trucks
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dispatchSetupPath, `${JSON.stringify(configPayload, null, 2)}\n`);
  return payload;
}

async function dispatchFleetDisableConflicts({ driver = null, truck = null } = {}) {
  const today = localDateDaysAgo(0);
  const planRows = await query(
    `SELECT p.id, p.plan_date::text, p.status, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.plan_date >= $1::date
        AND lower(p.status) NOT IN ('cancelled', 'canceled', 'archived')
      ORDER BY p.plan_date ASC, p.id ASC`,
    [today]
  );
  const todayPlans = planRows.rows.filter((row) => String(row.plan_date || "").slice(0, 10) === today);
  for (const row of todayPlans) {
    await syncDispatchPlanLoadAssignments({
      id: row.id,
      planDate: row.plan_date,
      orders: row.orders || [],
      trucks: row.trucks || [],
      summary: row.summary || {}
    });
  }
  if (todayPlans.length) {
    const completed = await query(
      `SELECT plan_id::text, array_agg(load_id ORDER BY load_id) FILTER (WHERE completed = true) AS completed_load_ids
         FROM dispatch_plan_load_assignments
        WHERE plan_id = ANY($1::bigint[])
        GROUP BY plan_id`,
      [todayPlans.map((row) => String(row.id))]
    );
    const completedByPlan = new Map(completed.rows.map((row) => [String(row.plan_id), row.completed_load_ids || []]));
    for (const row of todayPlans) row.completedLoadIds = completedByPlan.get(String(row.id)) || [];
  }
  const driverLogin = String(driver?.login || "").trim().toLowerCase();
  const truckPlate = normalizedPlate(truck?.plate);
  const resourceLabel = driver?.name || driver?.login || truck?.plate || "This resource";
  const conflicts = dispatchFleetPlanConflicts(planRows.rows, {
    driver,
    truck,
    drivers: driver ? await listDispatchDrivers({ activeOnly: false }) : null,
    trucks: truck ? await listDispatchTrucks({ activeOnly: false }) : null
  });

  if (driver) {
    const onDuty = await query(
        `SELECT plan_date::text, current_load_id
           FROM driver_day_records
          WHERE lower(driver_login) = $1
            AND on_duty_at IS NOT NULL
            AND off_duty_at IS NULL
          ORDER BY plan_date DESC
          LIMIT 5`,
        [driverLogin]
      );
    const activeJobs = await query(
        `SELECT plan_date::text, load_id, load_name, job_id
           FROM driver_job_records
          WHERE lower(driver_login) = $1
            AND status = 'in_progress'
          ORDER BY started_at DESC NULLS LAST
          LIMIT 5`,
        [driverLogin]
      );
    const switches = await query(
        `SELECT plan_date::text, next_load_id, job_id, status
           FROM driver_truck_switch_records
          WHERE lower(driver_login) = $1
            AND status IN ('pending', 'attention')
          ORDER BY plan_date DESC
          LIMIT 5`,
        [driverLogin]
      );
    for (const row of onDuty.rows) conflicts.push({
      type: "on_duty",
      planDate: String(row.plan_date || "").slice(0, 10),
      loadId: row.current_load_id || "",
      message: `${resourceLabel} is currently on duty.`
    });
    for (const row of activeJobs.rows) conflicts.push({
      type: "active_job",
      planDate: String(row.plan_date || "").slice(0, 10),
      loadId: row.load_id || "",
      jobId: row.job_id || "",
      message: `${resourceLabel} has an in-progress driver job${row.load_name ? ` on ${row.load_name}` : ""}.`
    });
    for (const row of switches.rows) conflicts.push({
      type: "truck_switch",
      planDate: String(row.plan_date || "").slice(0, 10),
      loadId: row.next_load_id || "",
      jobId: row.job_id || "",
      message: `${resourceLabel} has a ${row.status} truck switch.`
    });
  }

  if (truck) {
    const activeJobs = await query(
        `SELECT plan_date::text, load_id, load_name, job_id
           FROM driver_job_records
          WHERE upper(regexp_replace(COALESCE(truck_plate, ''), '\\s+', '', 'g')) = $1
            AND status = 'in_progress'
          ORDER BY started_at DESC NULLS LAST
          LIMIT 5`,
        [truckPlate]
      );
    const activeDays = await query(
        `SELECT plan_date::text, current_load_id, driver_login
           FROM driver_day_records
          WHERE upper(regexp_replace(COALESCE(NULLIF(current_truck_plate, ''), truck_plate, ''), '\\s+', '', 'g')) = $1
            AND on_duty_at IS NOT NULL
            AND off_duty_at IS NULL
          ORDER BY plan_date DESC
          LIMIT 5`,
        [truckPlate]
      );
    const switches = await query(
        `SELECT plan_date::text, next_load_id, job_id, status
           FROM driver_truck_switch_records
          WHERE status IN ('pending', 'attention')
            AND (
              upper(regexp_replace(COALESCE(from_truck_plate, ''), '\\s+', '', 'g')) = $1
              OR upper(regexp_replace(COALESCE(to_truck_plate, ''), '\\s+', '', 'g')) = $1
            )
          ORDER BY plan_date DESC
          LIMIT 5`,
        [truckPlate]
      );
    for (const row of activeJobs.rows) conflicts.push({
      type: "active_job",
      planDate: String(row.plan_date || "").slice(0, 10),
      loadId: row.load_id || "",
      jobId: row.job_id || "",
      message: `${resourceLabel} has an in-progress driver job${row.load_name ? ` on ${row.load_name}` : ""}.`
    });
    for (const row of activeDays.rows) conflicts.push({
      type: "on_duty",
      planDate: String(row.plan_date || "").slice(0, 10),
      loadId: row.current_load_id || "",
      message: `${resourceLabel} is assigned to on-duty driver ${row.driver_login}.`
    });
    for (const row of switches.rows) conflicts.push({
      type: "truck_switch",
      planDate: String(row.plan_date || "").slice(0, 10),
      loadId: row.next_load_id || "",
      jobId: row.job_id || "",
      message: `${resourceLabel} has a ${row.status} truck switch.`
    });
  }

  const seen = new Set();
  return conflicts.filter((conflict) => {
    const key = [conflict.type, conflict.planId, conflict.planDate, conflict.loadId, conflict.jobId, conflict.message].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function revokeDispatchDriverSessions(login) {
  const [sessionCount, grantCount] = await Promise.all([
    revokeDriverSessionsForLogin(login),
    revokeDriverOfflineGrants({ driverLogin: login })
  ]);
  return { sessionCount, grantCount };
}

async function withDispatchFleetPlanningLock(callback) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    return callback();
  });
}

function dispatchOrderStructureState(plan = {}) {
  const membership = new Map();
  const containers = new Map();
  const splitChildrenByParent = new Map();
  for (const order of plan.orders || []) {
    const id = String(order?.id || "").trim();
    if (!id) continue;
    const childRefs = [...new Set([
      ...(order?.childOrders || []),
      ...(order?.childOrderDetails || []).flatMap((child) => [child?.id, child?.originalOrderId])
    ].map((value) => String(value || "").trim()).filter(Boolean))].sort();
    const parentRef = String(order?.originalOrderId || "").trim();
    if (childRefs.length) {
      const token = `group:${id}:${childRefs.join("|")}`;
      containers.set(id, { signature: token, refs: [id, ...childRefs] });
      for (const ref of childRefs) membership.set(ref, token);
      continue;
    }
    if (parentRef) {
      if (!splitChildrenByParent.has(parentRef)) splitChildrenByParent.set(parentRef, []);
      splitChildrenByParent.get(parentRef).push(id);
      membership.set(id, `split-child:${parentRef}`);
      continue;
    }
    membership.set(id, "normal");
  }
  for (const [parentRef, childRefs] of splitChildrenByParent.entries()) {
    childRefs.sort();
    const token = `split:${childRefs.join("|")}`;
    membership.set(parentRef, token);
    containers.set(parentRef, { signature: token, refs: [parentRef, ...childRefs] });
  }
  return { membership, containers };
}

function changedDispatchOrderStructureRefs(previousPlan = {}, nextPlan = {}) {
  const before = dispatchOrderStructureState(previousPlan);
  const after = dispatchOrderStructureState(nextPlan);
  const refs = new Set();
  for (const key of before.membership.keys()) {
    if (!after.membership.has(key) || before.membership.get(key) === after.membership.get(key)) continue;
    refs.add(key);
  }
  for (const key of before.containers.keys()) {
    if (!after.containers.has(key)) continue;
    const left = before.containers.get(key);
    const right = after.containers.get(key);
    if (left.signature === right.signature) continue;
    for (const ref of [...left.refs, ...right.refs]) refs.add(ref);
  }
  return [...refs];
}

export function safeNormalDependencyGroupingRefs(previousPlan = {}, nextPlan = {}) {
  return safeNormalDependencyGroupingTargets(previousPlan, nextPlan)
    .map((target) => target.sourceOrderRef);
}

export function safeNormalDependencyGroupingTargets(previousPlan = {}, nextPlan = {}) {
  const before = dispatchOrderStructureState(previousPlan);
  return [...normalDispatchGroupTargets(nextPlan).entries()]
    .filter(([sourceOrderRef]) => before.membership.get(sourceOrderRef) === "normal")
    .map(([sourceOrderRef, groupRef]) => ({ sourceOrderRef, groupRef }));
}

export function safeEstablishedDependencyUngroupingTargets(previousPlan = {}, nextPlan = {}) {
  const after = dispatchOrderStructureState(nextPlan);
  const nextGroupTargets = normalDispatchGroupTargets(nextPlan);
  return [...normalDispatchGroupTargets(previousPlan).entries()]
    .filter(([sourceOrderRef]) =>
      after.membership.get(sourceOrderRef) === "normal"
      && !nextGroupTargets.has(sourceOrderRef)
    )
    .map(([sourceOrderRef, groupRef]) => ({ sourceOrderRef, groupRef }));
}

async function assertNoConsolidationStructureConflict(previousPlan, nextPlan) {
  const changedRefs = changedDispatchOrderStructureRefs(previousPlan, nextPlan);
  const safeGroupingTargets = safeNormalDependencyGroupingTargets(previousPlan, nextPlan);
  const safeUngroupTargets = safeEstablishedDependencyUngroupingTargets(previousPlan, nextPlan);
  const result = { safeGroupingTargets, safeUngroupTargets };
  if (!changedRefs.length) return result;
  await assertNoActiveConsolidationClaimsByRefs(changedRefs, "group, ungroup, split, or unsplit these orders");
  await assertNoActiveOrderDependenciesByRefs(
    changedRefs,
    "group, ungroup, split, or unsplit these orders",
    {
      allowNormalGroupingRefs: safeGroupingTargets.map((target) => target.sourceOrderRef),
      allowEstablishedGroupTargets: safeGroupingTargets,
      allowEstablishedUngroupTargets: safeUngroupTargets
    }
  );
  return result;
}

function normalizeOrderType(value) {
  return value === "transfer_order" || value === "transfer" ? "transfer_order" : "sales_order";
}

async function syncDeliveryLocation(locationId, { includeDetails = true, orderType = "sales_order" } = {}) {
  assertDispatchSyncCanContinue("delivery list");
  const normalizedOrderType = normalizeOrderType(orderType);
  const discoveredOrders = normalizedOrderType === "transfer_order"
    ? await fetchTransferDeliveryOrdersFromNetSuite(locationId)
    : await fetchDeliveryOrdersFromNetSuite(locationId);
  assertDispatchSyncCanContinue("delivery list");
  if (normalizedOrderType === "transfer_order") await upsertOutboundTransferOrders(discoveredOrders);
  else await upsertSalesOrders(discoveredOrders);

  const existingIds = await listExistingOutboundOrderIds({ locationId, orderFamily: normalizedOrderType });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];

  let orderCount = discoveredOrders.length;
  let detailCount = 0;
  let missingCount = 0;
  for (const orderId of orderIds) {
    assertDispatchSyncCanContinue(`delivery order ${orderId}`);
    const trackedOrder = normalizedOrderType === "transfer_order"
      ? await fetchTransferDeliveryOrderFromNetSuite(orderId, locationId)
      : await fetchDeliveryOrderFromNetSuite(orderId, locationId);
    assertDispatchSyncCanContinue(`delivery order ${orderId}`);
    if (!trackedOrder) {
      await markOutboundOrderMissing(orderId, { orderFamily: normalizedOrderType });
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: "netsuite.order.missing",
        orderId,
        details: { locationId }
      });
      missingCount += 1;
      continue;
    }

    if (normalizedOrderType === "transfer_order") await upsertOutboundTransferOrders([trackedOrder]);
    else await upsertSalesOrders([trackedOrder]);
    if (!discoveredOrders.some((order) => String(order.id) === String(orderId))) orderCount += 1;

    if (includeDetails) {
      assertDispatchSyncCanContinue(`delivery detail ${orderId}`);
      const lines = normalizedOrderType === "transfer_order"
        ? await fetchTransferOrderDetailsFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      assertDispatchSyncCanContinue(`delivery detail ${orderId}`);
      if (normalizedOrderType === "transfer_order") await upsertOutboundTransferOrderLines(orderId, lines);
      else await upsertSalesOrderLines(orderId, lines);
      await markMissingOutboundOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }

  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.delivery.sync",
    details: { locationId, orderType: normalizedOrderType, discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount }
  });

  return { discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount };
}

let syncRunning = false;
let activeSyncRun = null;
let targetedSyncRunning = false;

async function findLocalTargetedOrder({ orderType, orderRef }) {
  const table = {
    sales_order: "sales_orders",
    purchase_order: "purchase_orders",
    transfer_order: "transfer_orders"
  }[orderType];
  if (!table) return null;
  const result = await query(
    `SELECT netsuite_id AS id, tranid, status, status_text
       FROM ${table}
      WHERE upper(tranid) = upper($1)
        AND netsuite_id > 0
      ORDER BY synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  return result.rows[0] || null;
}

const targetedOrderSyncDependencies = {
  findLocalOrder: findLocalTargetedOrder,
  findNetSuiteOrder: ({ orderRef, netSuiteType }) => fetchTransactionReferenceByTranidFromNetSuite(orderRef, netSuiteType),
  fetchSalesOrder: fetchSalesOrderReferenceFromNetSuite,
  fetchSalesOrderLines: fetchDeliveryOrderDetailsFromNetSuite,
  upsertSalesOrders,
  upsertSalesOrderLines,
  markMissingOutboundOrderLines,
  fetchPurchaseOrder: fetchPurchaseOrderReferenceFromNetSuite,
  fetchPurchaseOrderLines: fetchPurchaseOrderDetailsFromNetSuite,
  upsertPurchaseOrders,
  upsertPurchaseOrderLines,
  markMissingInboundOrderLines,
  fetchTransferOrder: fetchTransferOrderByIdFromNetSuite,
  fetchTransferOrderLines: fetchTransferOrderDetailsFromNetSuite,
  upsertOutboundTransferOrders,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertInboundTransferOrderLines,
  writeAudit,
  emitEvent: emitAppEvent
};

function netSuiteJobMapHasRunningWork(jobs) {
  for (const job of jobs.values()) {
    if (String(job?.status || "").toLowerCase() === "running") return true;
  }
  return false;
}

function anyNetSuiteSyncRunning() {
  return syncRunning
    || Boolean(activeSyncRun)
    || targetedSyncRunning
    || netSuiteJobMapHasRunningWork(fulfillmentJobs)
    || netSuiteJobMapHasRunningWork(receivingJobs)
    || returnPendingSyncRunning
    || returnReconciliationRunning;
}

class DispatchSyncStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DispatchSyncStoppedError";
  }
}

function assertDispatchSyncCanContinue(context = "") {
  if (!activeSyncRun) return;
  if (activeSyncRun.cancelRequested) {
    throw new DispatchSyncStoppedError(activeSyncRun.cancelReason || "Sync was stopped by an admin.");
  }
  if (Date.now() > activeSyncRun.deadlineAt) {
    activeSyncRun.cancelRequested = true;
    activeSyncRun.cancelReason = `Sync stopped after exceeding ${activeSyncRun.maxRunSeconds} seconds${context ? ` at ${context}` : ""}.`;
    throw new DispatchSyncStoppedError(activeSyncRun.cancelReason);
  }
}

function syncAuditAction(source, { failed = false, stopped = false } = {}) {
  if (source === "auto") {
    if (stopped) return "netsuite.auto_sync_stopped";
    if (failed) return "netsuite.auto_sync_failed";
    return "netsuite.auto_sync";
  }
  if (source === "control_inbound_transfer_manual") {
    if (stopped) return "netsuite.to_po_sync_stopped";
    if (failed) return "netsuite.to_po_sync_failed";
    return "netsuite.to_po_sync";
  }
  if (stopped) return "netsuite.manual_sync_stopped";
  if (failed) return "netsuite.manual_sync_failed";
  return "netsuite.manual_sync";
}

async function runDispatchSync({ source = "manual", actorOperatorId = null, orderScope = "all" } = {}) {
  if (anyNetSuiteSyncRunning()) {
    return { skipped: true, reason: "sync_running" };
  }
  syncRunning = true;
  const runId = crypto.randomUUID();
  const settings = (await readDispatchSetup()).sync;
  const maxRunSeconds = Number(settings.maxRunSeconds || defaultDispatchSetup.sync.maxRunSeconds);
  activeSyncRun = {
    id: runId,
    source,
    maxRunSeconds,
    deadlineAt: Date.now() + (maxRunSeconds * 1000),
    cancelRequested: false,
    cancelReason: ""
  };
  const startedAt = new Date().toISOString();
  await writeDispatchSetup({
    sync: {
      running: true,
      lastStartedAt: startedAt,
      lastSource: source,
      lastStatus: "running",
      lastError: ""
    }
  });
  try {
    assertDispatchSyncCanContinue("start");
    const synced = orderScope === "transfer_purchase_order"
      ? await syncTransferPurchaseOrderFeed()
      : await syncDispatchOrderFeed();
    assertDispatchSyncCanContinue("enrichment");
    const enriched = await refreshDispatchEnrichment();
    const finishedAt = new Date().toISOString();
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: "success",
        lastError: ""
      }
    });
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "netsuite",
      action: syncAuditAction(source),
      details: { orderScope, synced, enriched }
    });
    emitAppEvent("dispatch.orders.updated", { source, syncedAt: finishedAt });
    return { synced, enriched, startedAt, finishedAt };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const stopped = error instanceof DispatchSyncStoppedError;
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: stopped ? "stopped" : "failed",
        lastError: error.message
      }
    });
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "netsuite",
      action: syncAuditAction(source, { failed: !stopped, stopped }),
      details: { orderScope, error: error.message }
    });
    if (stopped) return { stopped: true, startedAt, finishedAt, error: error.message };
    throw error;
  } finally {
    if (activeSyncRun?.id === runId) activeSyncRun = null;
    syncRunning = false;
  }
}

async function stopDispatchSync({ actorOperatorId = null, reason = "Stopped manually from Control Panel." } = {}) {
  const setup = await readDispatchSetup();
  const hadActiveRun = Boolean(activeSyncRun && syncRunning);
  if (activeSyncRun) {
    activeSyncRun.cancelRequested = true;
    activeSyncRun.cancelReason = reason;
  }
  await writeDispatchSetup({
    sync: {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastStatus: hadActiveRun ? "stop_requested" : "stopped",
      lastError: hadActiveRun ? `${reason} The current NetSuite request will finish before the runner exits.` : reason
    }
  });
  await writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "control",
    action: hadActiveRun ? "sync.stop_requested" : "sync.running_flag_cleared",
    details: { previousStatus: setup.sync?.lastStatus || "", previousRunning: Boolean(setup.sync?.running), hadActiveRun }
  });
  return (await readDispatchSetup()).sync;
}

async function clearOperationalOrderData({ actorOperatorId = null } = {}) {
  if (anyNetSuiteSyncRunning()) {
    throw new Error("Stop the current sync before clearing order data.");
  }
  const tables = [
    "dispatch_so_po_allocations",
    "dispatch_operator_requests",
    "dispatch_audit_log",
    "driver_rest_records",
    "driver_job_records",
    "driver_day_records",
    "local_co_receipt_records",
    "co_order_lines",
    "co_orders",
    "local_co_order_lines",
    "local_co_orders",
    "dispatch_plan_snapshots",
    "dispatch_plans",
    "delivery_fulfillment_records",
    "delivery_preparation_records",
    "sales_order_lines",
    "transfer_order_lines",
    "purchase_order_lines",
    "sales_orders",
    "transfer_orders",
    "purchase_orders",
    "receiving_receipt_records",
    "operator_record_warnings"
  ];
  const counts = await withTransaction(async () => {
    const counts = {};
    for (const table of tables) {
      const result = await query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      counts[table] = result.rows[0]?.count || 0;
    }
    await query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    return counts;
  });
  await writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "control",
    action: "order_data.clear",
    details: { tables, counts }
  });
  await fs.rm(dispatchPlanPath, { force: true }).catch(() => {});
  emitAppEvent("dispatch.plan.cleared", { change: "order_data_clear" });
  emitAppEvent("dispatch.orders.updated", { change: "order_data_clear" });
  emitAppEvent("delivery.order.updated", { change: "order_data_clear" });
  emitAppEvent("receiving.order.updated", { change: "order_data_clear" });
  return { tables, counts };
}

function progressNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? Math.abs(number) : 0;
}

function roundProgressQuantity(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function progressHasConversion(line) {
  return progressNumber(line.to_plt) > 0
    || progressNumber(line.to_lyr) > 0
    || progressNumber(line.to_sec) > 0
    || progressNumber(line.to_pcs) > 0;
}

function deriveProgressUnits(line, salesQuantity) {
  const quantity = progressNumber(salesQuantity);
  if (!progressHasConversion(line)) {
    return { pallet_qty: 0, layer_qty: 0, section_qty: 0, piece_qty: quantity };
  }
  const explicit = {
    pallet_qty: progressNumber(line.pallet_qty),
    layer_qty: progressNumber(line.layer_qty),
    section_qty: progressNumber(line.section_qty),
    piece_qty: progressNumber(line.piece_qty)
  };
  if (progressNumber(line.quantity) === quantity && Object.values(explicit).some((item) => item > 0)) {
    return explicit;
  }
  let remaining = quantity;
  const next = { pallet_qty: 0, layer_qty: 0, section_qty: 0, piece_qty: 0 };
  const conversions = [
    ["pallet_qty", "to_plt"],
    ["layer_qty", "to_lyr"],
    ["section_qty", "to_sec"],
    ["piece_qty", "to_pcs"]
  ];
  for (const [qtyField, conversionField] of conversions) {
    const conversion = progressNumber(line[conversionField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = roundProgressQuantity(remaining - (units * conversion));
  }
  return next;
}

function progressLinePatch(line) {
  const orderedQty = progressNumber(line.quantity);
  const processedQty = Math.min(progressNumber(line.netsuite_received_qty), orderedQty);
  const totalUnits = deriveProgressUnits(line, orderedQty);
  const processedUnits = deriveProgressUnits(line, processedQty);
  return {
    orderedQty,
    processedQty,
    totalUnits,
    processedUnits,
    unit: line.unit || "",
    itemWeight: progressNumber(line.item_weight) || null,
    locationId: line.location_id || null,
    location: line.location || "",
    toPlt: line.to_plt || null,
    toLyr: line.to_lyr || null,
    toSec: line.to_sec || null,
    toPcs: line.to_pcs || null
  };
}

function progressSummary(lines = []) {
  return lines.reduce((sum, line) => {
    const ordered = progressNumber(line.quantity);
    const processed = Math.min(progressNumber(line.netsuite_received_qty), ordered);
    return {
      total: sum.total + ordered,
      processed: sum.processed + processed,
      open: sum.open + Math.max(ordered - processed, 0)
    };
  }, { total: 0, processed: 0, open: 0 });
}

function isPickableProgressLine(line) {
  return ["InvtPart", "NonInvtPart"].includes(String(line.item_type || ""));
}

function statusTextIsComplete(statusText = "", orderType = "sales_order") {
  const text = String(statusText || "").toLowerCase();
  if (orderType === "purchase_order") return text.includes("received") || text.includes("billed");
  return text.includes("fulfilled") || text.includes("pending billing") || text.includes("billed");
}

async function updateSalesOrderLineFromProgress(orderId, line) {
  const patch = progressLinePatch(line);
  await query(
    `UPDATE sales_order_lines
        SET quantity = $3,
            unit = COALESCE(NULLIF($4, ''), unit),
            item_weight = COALESCE($5, item_weight),
            location_id = COALESCE($6::bigint, location_id),
            location = COALESCE(NULLIF($7, ''), location),
            pallet_qty = $8,
            layer_qty = $9,
            piece_qty = $10,
            section_qty = $11,
            to_plt = COALESCE($12::numeric, to_plt),
            to_lyr = COALESCE($13::numeric, to_lyr),
            to_sec = COALESCE($14::numeric, to_sec),
            to_pcs = COALESCE($15::numeric, to_pcs),
            loaded_qty = $16,
            loaded_uom = COALESCE(NULLIF($4, ''), loaded_uom),
            packed_pallet_qty = 0,
            packed_layer_qty = 0,
            packed_piece_qty = 0,
            packed_section_qty = 0,
            fulfilled_pallet_qty = $17,
            fulfilled_layer_qty = $18,
            fulfilled_piece_qty = $19,
            fulfilled_section_qty = $20,
            confirmed = false,
            confirmed_at = null,
            netsuite_active = true,
            sync_exception = null,
            sync_exception_at = null,
            synced_at = now()
      WHERE sales_order_id = $1
        AND line_id = $2`,
    [
      orderId,
      line.line_id,
      patch.orderedQty,
      patch.unit,
      patch.itemWeight,
      patch.locationId,
      patch.location,
      patch.totalUnits.pallet_qty,
      patch.totalUnits.layer_qty,
      patch.totalUnits.piece_qty,
      patch.totalUnits.section_qty,
      patch.toPlt,
      patch.toLyr,
      patch.toSec,
      patch.toPcs,
      patch.processedQty,
      patch.processedUnits.pallet_qty,
      patch.processedUnits.layer_qty,
      patch.processedUnits.piece_qty,
      patch.processedUnits.section_qty
    ]
  );
  return patch;
}

async function updateTransferOrderLineFromProgress(orderId, line, stage) {
  const patch = progressLinePatch(line);
  const isOutbound = stage === "outbound";
  await query(
    `UPDATE transfer_order_lines
        SET quantity = $4,
            unit = COALESCE(NULLIF($5, ''), unit),
            item_weight = COALESCE($6, item_weight),
            location_id = COALESCE($7::bigint, location_id),
            location = COALESCE(NULLIF($8, ''), location),
            pallet_qty = $9,
            layer_qty = $10,
            piece_qty = $11,
            section_qty = $12,
            to_plt = COALESCE($13::numeric, to_plt),
            to_lyr = COALESCE($14::numeric, to_lyr),
            to_sec = COALESCE($15::numeric, to_sec),
            to_pcs = COALESCE($16::numeric, to_pcs),
            loaded_qty = CASE WHEN $17::boolean THEN $18 ELSE loaded_qty END,
            loaded_uom = CASE WHEN $17::boolean THEN COALESCE(NULLIF($5, ''), loaded_uom) ELSE loaded_uom END,
            packed_pallet_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_pallet_qty END,
            packed_layer_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_layer_qty END,
            packed_piece_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_piece_qty END,
            packed_section_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_section_qty END,
            fulfilled_pallet_qty = CASE WHEN $17::boolean THEN $19 ELSE fulfilled_pallet_qty END,
            fulfilled_layer_qty = CASE WHEN $17::boolean THEN $20 ELSE fulfilled_layer_qty END,
            fulfilled_piece_qty = CASE WHEN $17::boolean THEN $21 ELSE fulfilled_piece_qty END,
            fulfilled_section_qty = CASE WHEN $17::boolean THEN $22 ELSE fulfilled_section_qty END,
            netsuite_received_qty = CASE WHEN $17::boolean THEN netsuite_received_qty ELSE $18 END,
            received_pallet_qty = CASE WHEN $17::boolean THEN received_pallet_qty ELSE 0 END,
            received_layer_qty = CASE WHEN $17::boolean THEN received_layer_qty ELSE 0 END,
            received_piece_qty = CASE WHEN $17::boolean THEN received_piece_qty ELSE 0 END,
            received_section_qty = CASE WHEN $17::boolean THEN received_section_qty ELSE 0 END,
            confirmed = false,
            confirmed_at = null,
            netsuite_active = true,
            sync_exception = null,
            sync_exception_at = null,
            synced_at = now()
      WHERE transfer_order_id = $1
        AND line_stage = $2
        AND line_id = $3`,
    [
      orderId,
      stage,
      line.line_id,
      patch.orderedQty,
      patch.unit,
      patch.itemWeight,
      patch.locationId,
      patch.location,
      patch.totalUnits.pallet_qty,
      patch.totalUnits.layer_qty,
      patch.totalUnits.piece_qty,
      patch.totalUnits.section_qty,
      patch.toPlt,
      patch.toLyr,
      patch.toSec,
      patch.toPcs,
      isOutbound,
      patch.processedQty,
      patch.processedUnits.pallet_qty,
      patch.processedUnits.layer_qty,
      patch.processedUnits.piece_qty,
      patch.processedUnits.section_qty
    ]
  );
  return patch;
}

async function updatePurchaseOrderLineFromProgress(orderId, line) {
  const patch = progressLinePatch(line);
  await query(
    `UPDATE purchase_order_lines
        SET quantity = $3,
            unit = COALESCE(NULLIF($4, ''), unit),
            item_weight = COALESCE($5, item_weight),
            location_id = COALESCE($6::bigint, location_id),
            location = COALESCE(NULLIF($7, ''), location),
            pallet_qty = $8,
            layer_qty = $9,
            piece_qty = $10,
            section_qty = $11,
            to_plt = COALESCE($12::numeric, to_plt),
            to_lyr = COALESCE($13::numeric, to_lyr),
            to_sec = COALESCE($14::numeric, to_sec),
            to_pcs = COALESCE($15::numeric, to_pcs),
            netsuite_received_qty = $16,
            received_pallet_qty = 0,
            received_layer_qty = 0,
            received_piece_qty = 0,
            received_section_qty = 0,
            netsuite_active = true,
            sync_exception = null,
            sync_exception_at = null,
            synced_at = now()
      WHERE purchase_order_id = $1
        AND line_id = $2`,
    [
      orderId,
      line.line_id,
      patch.orderedQty,
      patch.unit,
      patch.itemWeight,
      patch.locationId,
      patch.location,
      patch.totalUnits.pallet_qty,
      patch.totalUnits.layer_qty,
      patch.totalUnits.piece_qty,
      patch.totalUnits.section_qty,
      patch.toPlt,
      patch.toLyr,
      patch.toSec,
      patch.toPcs,
      patch.processedQty
    ]
  );
  return patch;
}

function localOutboundStatusFromSummary(summary, statusText) {
  if (summary.processed <= 0 && !statusTextIsComplete(statusText, "sales_order")) {
    return { operatorStatus: "open", yardStatus: "Open", fulfillmentStatus: "not_fulfilled" };
  }
  if (summary.open <= 0.000001 || statusTextIsComplete(statusText, "sales_order")) {
    return { operatorStatus: "loaded", yardStatus: "Loaded", fulfillmentStatus: "fulfilled" };
  }
  return { operatorStatus: "partial_loaded", yardStatus: "Partial Loaded", fulfillmentStatus: "partial_fulfilled" };
}

function localReceiptStatusFromSummary(summary, statusText, orderType) {
  if (summary.processed <= 0 && !statusTextIsComplete(statusText, orderType)) return "not_received";
  if (summary.open <= 0.000001 || statusTextIsComplete(statusText, orderType)) return "received";
  return "partial_received";
}

function transferProgressLineKey(line) {
  return [
    line.item_id || "",
    line.location_id || "",
    progressNumber(line.quantity),
    line.item_description || "",
    progressNumber(line.pallet_qty),
    progressNumber(line.layer_qty),
    progressNumber(line.section_qty),
    progressNumber(line.piece_qty)
  ].join("|");
}

function dedupeTransferProgressLines(lines = []) {
  const best = new Map();
  for (const line of lines || []) {
    const key = transferProgressLineKey(line);
    const current = best.get(key);
    if (!current || progressNumber(line.netsuite_received_qty) >= progressNumber(current.netsuite_received_qty)) {
      best.set(key, line);
    }
  }
  return [...best.values()];
}

function transferProgressLinesForStage(progress, stage) {
  const locationId = stage === "outbound" ? progress.source_location_id : progress.destination_location_id;
  const lines = (progress.lines || []).filter(isPickableProgressLine);
  if (!locationId && stage === "outbound" && progress.destination_location_id) {
    return dedupeTransferProgressLines(lines.filter((line) => String(line.location_id || "") !== String(progress.destination_location_id)));
  }
  if (!locationId) return dedupeTransferProgressLines(lines);
  return dedupeTransferProgressLines(lines.filter((line) => String(line.location_id || "") === String(locationId)));
}

async function reconcileSalesOrderProgress(progress) {
  const lines = (progress.lines || []).filter(isPickableProgressLine);
  for (const line of lines) await updateSalesOrderLineFromProgress(progress.id, line);
  const summary = progressSummary(lines);
  const status = localOutboundStatusFromSummary(summary, progress.status_text);
  await query(
    `UPDATE sales_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            operator_status = $4,
            local_yard_order_status = $5,
            fulfillment_status = $6,
            fulfilled_at = CASE WHEN $6 IN ('fulfilled', 'partial_fulfilled') THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [progress.id, progress.status || null, progress.status_text || null, status.operatorStatus, status.yardStatus, status.fulfillmentStatus]
  );
  await enqueueNetSuiteMirrorOrderEvent("sales_order", progress.id, { changeType: "progress" });
  return { lines: lines.length, ...summary, ...status };
}

async function reconcilePurchaseOrderProgress(progress) {
  const lines = (progress.lines || []).filter(isPickableProgressLine);
  for (const line of lines) await updatePurchaseOrderLineFromProgress(progress.id, line);
  const summary = progressSummary(lines);
  const receiptStatus = localReceiptStatusFromSummary(summary, progress.status_text, "purchase_order");
  await query(
    `UPDATE purchase_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            receipt_status = $4,
            received_at = CASE WHEN $4 IN ('received', 'partial_received') THEN COALESCE(received_at, now()) ELSE received_at END,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [progress.id, progress.status || null, progress.status_text || null, receiptStatus]
  );
  await enqueueNetSuiteMirrorOrderEvent("purchase_order", progress.id, { changeType: "progress" });
  return { lines: lines.length, ...summary, receiptStatus };
}

async function reconcileTransferOrderProgress(progress) {
  const outboundLines = transferProgressLinesForStage(progress, "outbound");
  const receivingLines = transferProgressLinesForStage(progress, "receiving");
  for (const line of outboundLines) await updateTransferOrderLineFromProgress(progress.id, line, "outbound");
  for (const line of receivingLines) await updateTransferOrderLineFromProgress(progress.id, line, "receiving");
  const outboundSummary = progressSummary(outboundLines);
  const receivingSummary = progressSummary(receivingLines);
  const outboundStatus = localOutboundStatusFromSummary(outboundSummary, progress.status_text);
  const receiptStatus = localReceiptStatusFromSummary(receivingSummary, progress.status_text, "purchase_order");
  await query(
    `UPDATE transfer_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            outbound_operator_status = $4,
            local_yard_order_status = $5,
            fulfillment_status = $6,
            receiving_status = $7,
            fulfilled_at = CASE WHEN $6 IN ('fulfilled', 'partial_fulfilled') THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END,
            received_at = CASE WHEN $7 IN ('received', 'partial_received') THEN COALESCE(received_at, now()) ELSE received_at END,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [
      progress.id,
      progress.status || null,
      progress.status_text || null,
      outboundStatus.operatorStatus,
      outboundStatus.yardStatus,
      outboundStatus.fulfillmentStatus,
      receiptStatus
    ]
  );
  await enqueueNetSuiteMirrorOrderEvent("transfer_order", progress.id, { changeType: "progress" });
  return {
    outbound: { lines: outboundLines.length, ...outboundSummary, ...outboundStatus },
    receiving: { lines: receivingLines.length, ...receivingSummary, receiptStatus }
  };
}

async function reconcileNetSuiteProgress({ actorOperatorId = null } = {}) {
  const summary = {
    salesOrders: { checked: 0, updated: 0, failed: 0 },
    purchaseOrders: { checked: 0, updated: 0, failed: 0 },
    transferOrders: { checked: 0, updated: 0, failed: 0 },
    failures: []
  };
  const targets = [
    {
      key: "salesOrders",
      table: "sales_orders",
      recordType: "SalesOrd",
      apply: reconcileSalesOrderProgress,
      where: `
        netsuite_id > 0
        AND tranid NOT LIKE '%-S%'
        AND NOT EXISTS (
          SELECT 1
            FROM sales_orders split_child
           WHERE split_child.tranid LIKE sales_orders.tranid || '-S%'
             AND split_child.netsuite_active = true
        )`
    },
    {
      key: "purchaseOrders",
      table: "purchase_orders",
      recordType: "PurchOrd",
      apply: reconcilePurchaseOrderProgress,
      where: "netsuite_id > 0"
    },
    {
      key: "transferOrders",
      table: "transfer_orders",
      recordType: "TrnfrOrd",
      apply: reconcileTransferOrderProgress,
      where: `
        netsuite_id > 0
        AND tranid NOT LIKE '%-S%'
        AND NOT EXISTS (
          SELECT 1
            FROM transfer_orders split_child
           WHERE split_child.tranid LIKE transfer_orders.tranid || '-S%'
             AND split_child.netsuite_active = true
        )`
    }
  ];
  for (const target of targets) {
    const ids = await query(`SELECT netsuite_id, tranid FROM ${target.table} WHERE ${target.where} ORDER BY synced_at ASC NULLS FIRST, netsuite_id`);
    for (const row of ids.rows) {
      assertDispatchSyncCanContinue(`progress reconcile ${row.tranid || row.netsuite_id}`);
      summary[target.key].checked += 1;
      try {
        const progress = await fetchTransactionProgressFromNetSuite(row.netsuite_id, target.recordType);
        if (!progress) continue;
        const result = await withTransaction(() => target.apply(progress));
        summary[target.key].updated += 1;
        await writeAudit({
          actorType: actorOperatorId ? "operator" : "system",
          actorOperatorId,
          source: "netsuite",
          action: "netsuite.progress_reconcile.order",
          orderId: row.netsuite_id,
          details: { table: target.table, tranid: row.tranid, result }
        });
      } catch (error) {
        summary[target.key].failed += 1;
        summary.failures.push({ orderType: target.key, netsuiteId: row.netsuite_id, tranid: row.tranid, error: error.message });
      }
    }
  }
  await writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "netsuite",
    action: "netsuite.progress_reconcile",
    details: summary
  });
  emitAppEvent("dispatch.orders.updated", { source: "netsuite-progress-reconcile" });
  emitAppEvent("delivery.order.updated", { source: "netsuite-progress-reconcile" });
  emitAppEvent("receiving.order.updated", { source: "netsuite-progress-reconcile" });
  return summary;
}

async function runNetSuiteProgressReconcile({ source = "control_reconcile", actorOperatorId = null } = {}) {
  if (anyNetSuiteSyncRunning()) return { skipped: true, reason: "sync_running" };
  syncRunning = true;
  const runId = crypto.randomUUID();
  const settings = (await readDispatchSetup()).sync;
  const maxRunSeconds = Number(settings.maxRunSeconds || defaultDispatchSetup.sync.maxRunSeconds);
  activeSyncRun = {
    id: runId,
    source,
    maxRunSeconds,
    deadlineAt: Date.now() + (maxRunSeconds * 1000),
    cancelRequested: false,
    cancelReason: ""
  };
  const startedAt = new Date().toISOString();
  await writeDispatchSetup({
    sync: {
      running: true,
      lastStartedAt: startedAt,
      lastSource: source,
      lastStatus: "running",
      lastError: ""
    }
  });
  try {
    const reconciled = await reconcileNetSuiteProgress({ actorOperatorId });
    const finishedAt = new Date().toISOString();
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: reconciled.failures.length ? "warning" : "success",
        lastError: reconciled.failures.length ? `${reconciled.failures.length} order(s) could not be reconciled. Check audit log.` : ""
      }
    });
    return { reconciled, startedAt, finishedAt };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const stopped = error instanceof DispatchSyncStoppedError;
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: stopped ? "stopped" : "failed",
        lastError: error.message
      }
    });
    if (stopped) return { stopped: true, startedAt, finishedAt, error: error.message };
    throw error;
  } finally {
    if (activeSyncRun?.id === runId) activeSyncRun = null;
    syncRunning = false;
  }
}

async function autoSyncTick() {
  try {
    if (!config.netsuite.directAccessEnabled) return;
    const setup = await readDispatchSetup();
    if (setup.sync?.mode !== "auto") return;
    await runDispatchSync({ source: "auto" });
  } catch (error) {
    console.error("Dispatch auto-sync failed:", error.message);
  }
}

async function recoverInterruptedSyncState() {
  const setup = await readDispatchSetup();
  if (!setup.sync?.running) return;
  await writeDispatchSetup({
    sync: {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastStatus: "interrupted",
      lastError: "Server restarted before the sync completed. Please run sync again if needed."
    }
  });
}

async function syncDispatchOrderFeed() {
  const deliveryResults = [];
  const receivingResults = [];
  for (const locationId of deliveryLocations) {
    assertDispatchSyncCanContinue(`location ${locationId} sales orders`);
    deliveryResults.push({
      locationId,
      orderType: "sales_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "sales_order" })
    });
    assertDispatchSyncCanContinue(`location ${locationId} transfer delivery orders`);
    deliveryResults.push({
      locationId,
      orderType: "transfer_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "transfer_order" })
    });
    assertDispatchSyncCanContinue(`location ${locationId} purchase receiving orders`);
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "purchase_order",
      synced: await syncPurchaseReceiving({ locationId })
    });
    assertDispatchSyncCanContinue(`location ${locationId} transfer receiving orders`);
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "transfer_order",
      synced: await syncTransferReceiving({ destinationLocationId: locationId })
    });
  }
  return { delivery: deliveryResults, receiving: receivingResults };
}

async function syncTransferPurchaseOrderFeed() {
  const deliveryResults = [];
  const receivingResults = [];
  for (const locationId of deliveryLocations) {
    assertDispatchSyncCanContinue(`location ${locationId} transfer delivery orders`);
    deliveryResults.push({
      locationId,
      orderType: "transfer_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "transfer_order" })
    });
    assertDispatchSyncCanContinue(`location ${locationId} purchase receiving orders`);
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "purchase_order",
      synced: await syncPurchaseReceiving({ locationId })
    });
    assertDispatchSyncCanContinue(`location ${locationId} transfer receiving orders`);
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "transfer_order",
      synced: await syncTransferReceiving({ destinationLocationId: locationId })
    });
  }
  return { delivery: deliveryResults, receiving: receivingResults };
}

async function syncPurchaseReceiving({ locationId = 1, includeDetails = true } = {}) {
  assertDispatchSyncCanContinue("purchase order list");
  const discoveredOrders = await fetchPurchaseOrdersFromNetSuite(locationId);
  assertDispatchSyncCanContinue("purchase order list");
  await upsertPurchaseOrders(discoveredOrders);
  const existingIds = await listExistingInboundOrderIds({ orderFamily: "purchase_order", destinationLocationId: locationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];
  let detailCount = 0;
  for (const orderId of orderIds) {
    assertDispatchSyncCanContinue(`purchase order ${orderId}`);
    const trackedOrder = await fetchPurchaseOrderFromNetSuite(orderId, locationId);
    assertDispatchSyncCanContinue(`purchase order ${orderId}`);
    if (!trackedOrder) continue;
    await upsertPurchaseOrders([trackedOrder]);
    if (includeDetails) {
      assertDispatchSyncCanContinue(`purchase order detail ${orderId}`);
      const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, locationId);
      assertDispatchSyncCanContinue(`purchase order detail ${orderId}`);
      await upsertPurchaseOrderLines(orderId, lines);
      await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }
  await markMissingInboundOrders({ orderFamily: "purchase_order", activeOrderIds: discoveredOrders.map((order) => order.id), destinationLocationId: locationId });
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.receiving.purchase_order.sync",
    details: { locationId, discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount }
  });
  return { discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount };
}

async function syncTransferReceiving({ sourceLocationId = null, destinationLocationId = null, includeDetails = true } = {}) {
  assertDispatchSyncCanContinue("transfer receiving list");
  const discoveredOrders = await fetchTransferReceivingOrdersFromNetSuite({ sourceLocationId, destinationLocationId });
  assertDispatchSyncCanContinue("transfer receiving list");
  await upsertInboundTransferOrders(discoveredOrders);
  const existingIds = await listExistingInboundOrderIds({ orderFamily: "transfer_order", sourceLocationId, destinationLocationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];
  let detailCount = 0;
  for (const orderId of orderIds) {
    assertDispatchSyncCanContinue(`transfer receiving order ${orderId}`);
    const trackedOrder = await fetchTransferReceivingOrderFromNetSuite(orderId);
    assertDispatchSyncCanContinue(`transfer receiving order ${orderId}`);
    if (!trackedOrder) continue;
    await upsertInboundTransferOrders([trackedOrder]);
    if (includeDetails) {
      assertDispatchSyncCanContinue(`transfer receiving detail ${orderId}`);
      const lines = await fetchTransferOrderDetailsFromNetSuite(orderId, destinationLocationId || null, { direction: "destination" });
      assertDispatchSyncCanContinue(`transfer receiving detail ${orderId}`);
      await upsertInboundTransferOrderLines(orderId, lines);
      await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }
  await markMissingInboundOrders({
    orderFamily: "transfer_order",
    activeOrderIds: discoveredOrders.map((order) => order.id),
    sourceLocationId,
    destinationLocationId
  });
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.receiving.transfer_order.sync",
    details: { sourceLocationId, destinationLocationId, discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount }
  });
  return { discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount };
}

async function syncReceivingOrderDetails(orderId, { orderType = null, locationId = null, sourceLocationId = null } = {}) {
  const existing = await getReceivingOrder(orderId);
  const normalizedOrderType = orderType || existing?.order_type || "purchase_order";
  if (normalizedOrderType === "transfer_order") {
    const effectiveDestinationLocationId = locationId || existing?.destination_location_id || null;
    const storedSourceLocationId = existing?.source_location_id && String(existing.source_location_id) !== String(effectiveDestinationLocationId)
      ? existing.source_location_id
      : null;
    const effectiveSourceLocationId = sourceLocationId || storedSourceLocationId;
    const order = await fetchTransferReceivingOrderFromNetSuite(orderId, effectiveSourceLocationId);
    if (!order) return { order: false, lines: 0 };
    await upsertInboundTransferOrders([order]);
    const lines = await fetchTransferOrderDetailsFromNetSuite(orderId, effectiveDestinationLocationId || order.destination_location_id, { direction: "destination" });
    await upsertInboundTransferOrderLines(orderId, lines);
    await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
    return { order: true, orderType: "transfer_order", lines: lines.length };
  }

  const effectiveLocationId = locationId || existing?.destination_location_id || null;
  const order = await fetchPurchaseOrderFromNetSuite(orderId, effectiveLocationId);
  if (!order) return { order: false, lines: 0 };
  await upsertPurchaseOrders([order]);
  const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, effectiveLocationId);
  await upsertPurchaseOrderLines(orderId, lines);
  await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
  return { order: true, orderType: "purchase_order", lines: lines.length };
}

function webhookNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Math.abs(Number(String(value).replaceAll(",", ""))) || 0;
}

function webhookSignedNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : 0;
}

function webhookString(value) {
  return String(value ?? "").trim();
}

function webhookDate(value) {
  const text = webhookString(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text;
}

function webhookLocationText(value) {
  const text = webhookString(value);
  if (text === "1") return "3445";
  if (text === "13" || text === "28") return "2967";
  if (text === "15") return "12441";
  if (text === "26") return "150";
  return text;
}

function webhookRecordType(value) {
  const text = webhookString(value).toLowerCase();
  if (["salesorder", "salesord", "sales_order", "so"].includes(text)) return "sales_order";
  if (["purchaseorder", "purchord", "purchase_order", "po"].includes(text)) return "purchase_order";
  if (["transferorder", "trnfrord", "transfer_order", "to"].includes(text)) return "transfer_order";
  return "";
}

const EXCLUDED_SALES_ORDER_PREFIXES = ["SOT"];

function isExcludedSalesOrderRef(value) {
  const text = webhookString(value).toUpperCase();
  return EXCLUDED_SALES_ORDER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function webhookLineHasConversion(line) {
  return webhookNumber(line.to_plt ?? line.toPlt ?? line.custitem_toplt) > 0
    || webhookNumber(line.to_lyr ?? line.toLyr ?? line.custitem_tolyr) > 0
    || webhookNumber(line.to_sec ?? line.toSec ?? line.custitem_tosec) > 0
    || webhookNumber(line.to_pcs ?? line.toPcs ?? line.custitem_topcs) > 0;
}

function deriveWebhookQuantitiesFromSales(line, quantity) {
  if (!webhookLineHasConversion(line)) {
    return {
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0,
      quantity
    };
  }
  let remaining = quantity;
  const next = {
    pallet_qty: 0,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0,
    quantity
  };
  const conversions = [
    ["pallet_qty", "to_plt", "toPlt", "custitem_toplt"],
    ["layer_qty", "to_lyr", "toLyr", "custitem_tolyr"],
    ["section_qty", "to_sec", "toSec", "custitem_tosec"],
    ["piece_qty", "to_pcs", "toPcs", "custitem_topcs"]
  ];
  for (const [qtyField, snake, camel, netsuiteField] of conversions) {
    const conversion = webhookNumber(line[snake] ?? line[camel] ?? line[netsuiteField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = Number((remaining - (units * conversion)).toFixed(6));
  }
  return next;
}

function webhookLineLocationId(line, fallback = null) {
  const value = line.location_id ?? line.locationId ?? fallback;
  return value === null || value === undefined || value === "" ? "" : String(value);
}

function webhookProcessedQuantity(line, preferred = null, { fallbackOnZero = false } = {}) {
  const preferredNumber = webhookNumber(preferred);
  if (preferred !== null && preferred !== undefined && preferred !== "" && (preferredNumber > 0 || !fallbackOnZero)) {
    return preferredNumber;
  }
  return webhookNumber(
    line.netsuite_received_qty
    ?? line.quantityShipRecv
    ?? line.quantityshiprecv
    ?? line.quantityFulfilled
    ?? line.quantityReceived
    ?? line.quantityreceived
  );
}

function webhookLineSignedQuantity(line) {
  const signed = webhookSignedNumber(line.signedQuantity ?? line.signed_quantity ?? line.quantitySigned ?? line.quantity_signed);
  if (signed) return signed;
  return webhookSignedNumber(line.quantity);
}

function webhookLineDuplicateKey(line, fallbackLocationId = null) {
  return [
    line.item_id ?? line.itemId ?? "",
    webhookLineLocationId(line, fallbackLocationId),
    webhookNumber(line.quantity),
    line.item_description ?? line.itemDescription ?? line.description ?? "",
    webhookNumber(line.pallet_qty ?? line.pallets ?? line.custcol_plt ?? line.plt),
    webhookNumber(line.layer_qty ?? line.layers ?? line.custcol_lyr ?? line.lyr),
    webhookNumber(line.section_qty ?? line.sections ?? line.custcol_sec ?? line.sec),
    webhookNumber(line.piece_qty ?? line.pieces ?? line.custcol_pcs ?? line.pcs)
  ].join("|");
}

function dedupeWebhookTransferLines(lines, { locationId = null, direction = "source", processedField = null } = {}) {
  const targetLocation = locationId === null || locationId === undefined || locationId === "" ? "" : String(locationId);
  const filtered = lines.filter((line) => {
    const lineLocation = webhookLineLocationId(line);
    if (targetLocation && lineLocation) return lineLocation === targetLocation;
    if (targetLocation && !lineLocation) return true;
    const signedQuantity = webhookLineSignedQuantity(line);
    if (direction === "source") return signedQuantity < 0;
    if (direction === "destination") return signedQuantity > 0;
    return true;
  });

  const bestByDuplicateKey = new Map();
  for (const line of filtered) {
    const key = webhookLineDuplicateKey(line, locationId);
    const current = bestByDuplicateKey.get(key);
    if (
      !current
      || webhookProcessedQuantity(line, line[processedField], { fallbackOnZero: true })
        > webhookProcessedQuantity(current, current[processedField], { fallbackOnZero: true })
    ) {
      bestByDuplicateKey.set(key, line);
    }
  }
  return [...bestByDuplicateKey.values()];
}

function normalizeWebhookLine(line, { locationId = null, locationText = "", processedQuantity = null, remainingForDelivery = false } = {}) {
  const quantity = webhookNumber(line.quantity);
  const processed = webhookProcessedQuantity(line, processedQuantity);
  const remainingQuantity = Math.max(quantity - processed, 0);
  const manual = {
    pallet_qty: webhookNumber(line.pallet_qty ?? line.pallets ?? line.custcol_plt ?? line.plt),
    layer_qty: webhookNumber(line.layer_qty ?? line.layers ?? line.custcol_lyr ?? line.lyr),
    section_qty: webhookNumber(line.section_qty ?? line.sections ?? line.custcol_sec ?? line.sec),
    piece_qty: webhookNumber(line.piece_qty ?? line.pieces ?? line.custcol_pcs ?? line.pcs)
  };
  const hasManualPackQuantity = Object.values(manual).some((value) => value > 0);
  const derived = remainingForDelivery && processed > 0 && !hasManualPackQuantity
    ? deriveWebhookQuantitiesFromSales(line, remainingQuantity)
    : {
      ...manual,
      quantity: remainingForDelivery ? remainingQuantity : quantity
    };
  const hasConversion = webhookLineHasConversion(line);
  const packQuantitySource = hasManualPackQuantity ? "netsuite_manual" : hasConversion ? "item_conversion" : "sales_only";
  const syncException = remainingForDelivery && processed > 0 && hasManualPackQuantity && !hasConversion
    ? "manual_pack_partial_sales_unknown"
    : null;

  return {
    line_id: line.uniquekey ?? line.uniqueKey ?? line.lineUniqueKey ?? line.line_unique_key ?? line.line_id ?? line.lineId ?? line.id,
    item_id: line.item_id ?? line.itemId,
    item_name: line.item_name ?? line.itemName ?? line.sku,
    item_type: line.item_type ?? line.itemType,
    item_type_text: line.item_type_text ?? line.itemTypeText,
    item_description: line.item_description ?? line.itemDescription ?? line.description ?? "",
    quantity: derived.quantity,
    netsuite_committed_qty: webhookNumber(line.netsuite_committed_qty ?? line.quantityCommitted ?? line.quantitycommitted),
    netsuite_backordered_qty: webhookNumber(line.netsuite_backordered_qty ?? line.quantityBackordered ?? line.quantitybackordered),
    netsuite_received_qty: processed,
    unit: line.unit ?? line.unitText ?? "",
    item_weight: line.item_weight ?? line.itemWeight ?? line.weight,
    location_id: line.location_id ?? line.locationId ?? locationId,
    location: line.location ?? line.locationText ?? locationText,
    pallet_qty: derived.pallet_qty,
    layer_qty: derived.layer_qty,
    piece_qty: derived.piece_qty,
    section_qty: derived.section_qty,
    to_plt: line.to_plt ?? line.toPlt ?? line.custitem_toplt,
    to_lyr: line.to_lyr ?? line.toLyr ?? line.custitem_tolyr,
    to_sec: line.to_sec ?? line.toSec ?? line.custitem_tosec,
    to_pcs: line.to_pcs ?? line.toPcs ?? line.custitem_topcs,
    pack_quantity_source: packQuantitySource,
    sync_exception: syncException,
    raw: line
  };
}

function normalizeWebhookDeliveryOrder(payload, { type, locationId, locationText }) {
  const isTransfer = type === "transfer_order";
  return {
    id: payload.id,
    tranid: payload.tranid,
    trandate: webhookDate(payload.trandate),
    customer_id: isTransfer ? (payload.transferLocationId ?? payload.destinationLocationId) : payload.entityId,
    customer: isTransfer ? `Transfer to ${payload.transferLocationText || payload.destinationLocationText || ""}`.trim() : payload.entityText,
    status: payload.status,
    status_text: payload.statusText || payload.status_text,
    memo: payload.memo || payload.note || payload.custbody7 || "",
    expected_delivery_date: webhookDate(payload.expectedDeliveryDate || payload.custbody4),
    foreigntotal: payload.foreignTotal,
    order_location_id: isTransfer ? (payload.transferLocationId ?? payload.destinationLocationId) : payload.locationId,
    order_location: isTransfer ? (payload.transferLocationText ?? payload.destinationLocationText) : payload.locationText,
    outbound_location_id: locationId,
    outbound_location: locationText,
    delivery_method_id: payload.deliveryMethodId,
    delivery_method: isTransfer ? "Transfer Order" : payload.deliveryMethodText,
    order_type: type,
    source_location_id: isTransfer ? (payload.sourceLocationId ?? payload.locationId ?? locationId) : payload.sourceLocationId,
    source_location: isTransfer ? (payload.sourceLocationText ?? payload.locationText ?? locationText) : payload.sourceLocationText,
    destination_location_id: isTransfer ? (payload.transferLocationId ?? payload.destinationLocationId) : payload.destinationLocationId,
    destination_location: isTransfer ? (payload.transferLocationText ?? payload.destinationLocationText) : payload.destinationLocationText
  };
}

function normalizeWebhookReceivingOrder(payload, { type, locationId, locationText }) {
  const isTransfer = type === "transfer_order";
  return {
    id: payload.id,
    order_type: type,
    tranid: payload.tranid,
    trandate: webhookDate(payload.trandate),
    vendor_id: isTransfer ? (payload.sourceLocationId ?? payload.locationId) : payload.entityId,
    vendor: isTransfer ? (payload.sourceLocationText ?? payload.locationText) : payload.entityText,
    status: payload.status,
    status_text: payload.statusText || payload.status_text,
    memo: payload.memo || payload.note || payload.custbody7 || "",
    foreigntotal: payload.foreignTotal,
    source_location_id: isTransfer ? (payload.sourceLocationId ?? payload.locationId) : payload.sourceLocationId,
    source_location: isTransfer ? (payload.sourceLocationText ?? payload.locationText) : payload.sourceLocationText,
    destination_location_id: locationId,
    destination_location: locationText
  };
}

const DELAYED_STATUS_REFRESH_CONFIG = {
  sales_order: {
    netsuiteType: "SalesOrd",
    updateStatus: updateSalesOrderNetSuiteStatus,
    events: ["dispatch.orders.updated", "delivery.order.updated"]
  },
  purchase_order: {
    netsuiteType: "PurchOrd",
    updateStatus: updatePurchaseOrderNetSuiteStatus,
    events: ["dispatch.orders.updated", "receiving.order.updated"]
  }
};

function summarizeSalesOrderAllocationRefresh(lines = []) {
  const totals = (lines || []).reduce((summary, line) => {
    const quantity = webhookNumber(line.quantity);
    const committed = webhookNumber(line.netsuite_committed_qty);
    const backordered = webhookNumber(line.netsuite_backordered_qty);
    const processed = webhookNumber(line.netsuite_received_qty);
    summary.backorderedQuantity += backordered;
    if (backordered > 0) summary.backorderedLineCount += 1;
    if (quantity > 0 && committed <= 0 && backordered <= 0 && processed <= 0) {
      summary.unsettledLineCount += 1;
    }
    return summary;
  }, {
    lineCount: (lines || []).length,
    backorderedLineCount: 0,
    backorderedQuantity: 0,
    unsettledLineCount: 0
  });
  totals.backorderedQuantity = Number(totals.backorderedQuantity.toFixed(6));
  return totals;
}

async function refreshSalesOrderAllocationsAfterWebhook(orderId) {
  const lines = await fetchDeliveryOrderDetailsFromNetSuite(orderId);
  if (lines.length) await upsertSalesOrderLines(orderId, lines);
  return summarizeSalesOrderAllocationRefresh(lines);
}

function scheduleTransactionStatusRefresh(orderType, orderId, {
  tranid = "",
  delayMs = 10000,
  refreshAttempt = 0,
  maxLineRefreshAttempts = 2
} = {}) {
  const config = DELAYED_STATUS_REFRESH_CONFIG[orderType];
  if (!config) return;
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return;
  const key = `${orderType}:${id}`;
  const existing = delayedTransactionStatusRefreshes.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    delayedTransactionStatusRefreshes.delete(key);
    try {
      const status = await fetchTransactionStatusFromNetSuite(id, config.netsuiteType);
      const updated = status
        ? await config.updateStatus(id, {
            status: status.status,
            statusText: status.status_text
          })
        : false;
      let allocationRefresh = null;
      let allocationRefreshError = "";
      if (orderType === "sales_order") {
        try {
          allocationRefresh = await refreshSalesOrderAllocationsAfterWebhook(id);
        } catch (error) {
          allocationRefreshError = error.message;
        }
      }
      await writeAudit({
        actorType: "system",
        source: "netsuite-webhook",
        action: status
          ? "netsuite.webhook.delayed_status_refresh"
          : "netsuite.webhook.delayed_status_missing",
        details: {
          netsuiteOrderId: id,
          orderType,
          tranid: status?.tranid || tranid,
          status: status?.status || "",
          statusText: status?.status_text || "",
          updated: Boolean(updated),
          refreshAttempt: refreshAttempt + 1,
          allocationRefresh,
          allocationRefreshError
        }
      });
      for (const eventName of config.events) {
        emitAppEvent(eventName, { orderId: id, tranid: status?.tranid || tranid, orderType, source: "netsuite-webhook-delayed-status" });
      }
      const shouldRetryLineRefresh = orderType === "sales_order"
        && refreshAttempt + 1 < maxLineRefreshAttempts
        && (allocationRefreshError || Number(allocationRefresh?.unsettledLineCount || 0) > 0);
      if (shouldRetryLineRefresh) {
        scheduleTransactionStatusRefresh(orderType, id, {
          tranid: status?.tranid || tranid,
          delayMs: 30000,
          refreshAttempt: refreshAttempt + 1,
          maxLineRefreshAttempts
        });
      }
    } catch (error) {
      await writeAudit({
        actorType: "system",
        source: "netsuite-webhook",
        action: "netsuite.webhook.delayed_status_failed",
        details: { netsuiteOrderId: id, orderType, tranid, error: error.message }
      }).catch(() => {});
    }
  }, delayMs);
  delayedTransactionStatusRefreshes.set(key, timer);
}

function scheduleSalesOrderStatusRefresh(orderId, options = {}) {
  scheduleTransactionStatusRefresh("sales_order", orderId, options);
}

function schedulePurchaseOrderStatusRefresh(orderId, options = {}) {
  scheduleTransactionStatusRefresh("purchase_order", orderId, options);
}

export async function processNetSuiteOrderWebhook(payload = {}, { scheduleDelayedStatus = true } = {}) {
  const type = webhookRecordType(payload.recordType || payload.type || payload.orderType);
  if (!type) throw new Error("Unsupported NetSuite webhook record type.");
  if (!payload.id || !payload.tranid) throw new Error("Webhook payload requires id and tranid.");
  if (type === "sales_order" && isExcludedSalesOrderRef(payload.tranid)) {
    await writeAudit({
      actorType: "system",
      source: "netsuite-webhook",
      action: "netsuite.webhook.sales_order_ignored_prefix",
      details: {
        netsuiteOrderId: payload.id,
        tranid: payload.tranid,
        excludedPrefixes: EXCLUDED_SALES_ORDER_PREFIXES
      }
    });
    return {
      ok: true,
      ignored: true,
      reason: "excluded_sales_order_prefix",
      orderId: payload.id,
      tranid: payload.tranid,
      recordType: type
    };
  }
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const results = [];

  if (type === "sales_order") {
    const locationId = lines.find((line) => line.locationId || line.location_id)?.locationId || payload.locationId;
    const locationText = lines.find((line) => line.locationText || line.location)?.locationText || payload.locationText;
    const order = normalizeWebhookDeliveryOrder(payload, { type, locationId, locationText });
    const normalizedLines = lines.map((line) => normalizeWebhookLine(line, {
      locationId: line.locationId || line.location_id || locationId,
      locationText: line.locationText || line.location || locationText,
      processedQuantity: line.quantityFulfilled ?? line.quantityShipRecv,
      remainingForDelivery: true
    }));
    await upsertSalesOrders([order]);
    await upsertSalesOrderLines(order.id, normalizedLines);
    await markMissingOutboundOrderLines(order.id, normalizedLines.map((line) => line.line_id));
    results.push({ target: "sales_orders", orderType: type, lines: normalizedLines.length });
    if (scheduleDelayedStatus) scheduleSalesOrderStatusRefresh(payload.id, { tranid: payload.tranid });
  } else if (type === "purchase_order") {
    const locationId = lines.find((line) => line.locationId || line.location_id)?.locationId || payload.locationId;
    const locationText = lines.find((line) => line.locationText || line.location)?.locationText || payload.locationText;
    const order = normalizeWebhookReceivingOrder(payload, { type, locationId, locationText });
    const normalizedLines = lines.map((line) => normalizeWebhookLine(line, {
      locationId: line.locationId || line.location_id || locationId,
      locationText: line.locationText || line.location || locationText,
      processedQuantity: line.quantityReceived ?? line.quantityShipRecv
    }));
    await upsertPurchaseOrders([order]);
    await upsertPurchaseOrderLines(order.id, normalizedLines);
    await markMissingInboundOrderLines(order.id, normalizedLines.map((line) => line.line_id));
    results.push({ target: "purchase_orders", orderType: type, lines: normalizedLines.length });
    if (scheduleDelayedStatus) schedulePurchaseOrderStatusRefresh(payload.id, { tranid: payload.tranid });
  } else if (type === "transfer_order") {
    const sourceLocationId = payload.sourceLocationId || payload.locationId;
    const sourceLocationText = payload.sourceLocationText || payload.locationText || webhookLocationText(sourceLocationId);
    const destinationLocationId = payload.destinationLocationId || payload.transferLocationId;
    const destinationLocationText = payload.destinationLocationText || payload.transferLocationText || webhookLocationText(destinationLocationId);
    const deliveryOrder = normalizeWebhookDeliveryOrder(payload, { type, locationId: sourceLocationId, locationText: sourceLocationText });
    const deliveryLines = dedupeWebhookTransferLines(lines, {
      locationId: sourceLocationId,
      direction: "source",
      processedField: "quantityShipRecv"
    }).map((line) => normalizeWebhookLine(line, {
      locationId: sourceLocationId,
      locationText: sourceLocationText,
      processedQuantity: line.quantityShipRecv ?? line.quantityFulfilled,
      remainingForDelivery: true
    })).filter((line) => webhookNumber(line.quantity) > 0);
    await upsertOutboundTransferOrders([deliveryOrder]);
    await upsertOutboundTransferOrderLines(deliveryOrder.id, deliveryLines);
    await markMissingOutboundOrderLines(deliveryOrder.id, deliveryLines.map((line) => line.line_id));
    results.push({ target: "transfer_orders.outbound", orderType: type, lines: deliveryLines.length });

    const receivingOrder = normalizeWebhookReceivingOrder(payload, { type, locationId: destinationLocationId, locationText: destinationLocationText });
    const receivingLines = dedupeWebhookTransferLines(lines, {
      locationId: destinationLocationId,
      direction: "destination",
      processedField: "quantityShipRecv"
    }).map((line) => normalizeWebhookLine(line, {
      locationId: destinationLocationId,
      locationText: destinationLocationText,
      processedQuantity: line.quantityReceived ?? line.quantityShipRecv,
      remainingForDelivery: true
    })).filter((line) => webhookNumber(line.quantity) > 0);
    await upsertInboundTransferOrders([receivingOrder]);
    await upsertInboundTransferOrderLines(receivingOrder.id, receivingLines);
    await markMissingInboundOrderLines(receivingOrder.id, receivingLines.map((line) => line.line_id));
    results.push({ target: "transfer_orders.receiving", orderType: type, lines: receivingLines.length });
  }

  await writeAudit({
    actorType: "system",
    source: "netsuite-webhook",
    action: "netsuite.webhook.order",
    details: { netsuiteOrderId: payload.id, recordType: type, tranid: payload.tranid, eventType: payload.eventType || "", results }
  });
  emitAppEvent("dispatch.orders.updated", { orderId: payload.id, tranid: payload.tranid, source: "netsuite-webhook" });
  emitAppEvent("delivery.order.updated", { orderId: payload.id, tranid: payload.tranid, source: "netsuite-webhook" });
  emitAppEvent("receiving.order.updated", { orderId: payload.id, tranid: payload.tranid, source: "netsuite-webhook" });
  return { ok: true, orderId: payload.id, tranid: payload.tranid, recordType: type, results };
}

app.use(express.json({
  limit: "25mb",
  verify(req, res, buffer) {
    req.rawBody = buffer.toString("utf8");
  }
}));

app.use(async (req, res, next) => {
  if (process.env.MBBS_ENABLE_ROLLBACK_TESTS !== "1" || req.get("x-mbbs-rollback-test") !== "1") {
    return next();
  }
  let context;
  try {
    context = await beginRollbackContext();
  } catch (error) {
    return next(error);
  }

  let done = false;
  async function rollback() {
    if (done) return;
    done = true;
    await context.rollback().catch((error) => {
      console.error("Rollback test cleanup failed:", error);
    });
  }

  res.setHeader("x-mbbs-rollback-test", "true");
  res.on("finish", rollback);
  res.on("close", rollback);
  return context.run(() => next());
});

app.get("/api/internal/netsuite-sync/events", requireNetSuiteMirrorSignature, async (req, res, next) => {
  try {
    if (!isNetSuiteMirrorSource()) return res.status(409).json({ error: "This application is not the NetSuite mirror source." });
    res.json(await localNetSuiteMirrorEventPage({ after: req.query.after, limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/internal/netsuite-sync/manifest", requireNetSuiteMirrorSignature, async (req, res, next) => {
  try {
    if (!isNetSuiteMirrorSource()) return res.status(409).json({ error: "This application is not the NetSuite mirror source." });
    res.json(await listNetSuiteMirrorManifest({
      cursor: req.query.cursor,
      limit: req.query.limit,
      updatedAfter: req.query.updatedAfter
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/internal/netsuite-sync/orders/:entityType/:entityId", requireNetSuiteMirrorSignature, async (req, res, next) => {
  try {
    if (!isNetSuiteMirrorSource()) return res.status(409).json({ error: "This application is not the NetSuite mirror source." });
    const snapshot = await localNetSuiteMirrorOrderSnapshot(req.params.entityType, req.params.entityId);
    if (!snapshot) return res.status(404).json({ error: "NetSuite-backed order was not found in the source database." });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.post("/api/internal/netsuite-sync/inventory-snapshot", requireNetSuiteMirrorSignature, async (req, res, next) => {
  try {
    if (!isNetSuiteMirrorSource()) return res.status(409).json({ error: "This application is not the NetSuite mirror source." });
    res.json(await localNetSuiteMirrorInventorySnapshot(req.body?.itemIds || []));
  } catch (error) {
    next(error);
  }
});

app.get("/api/internal/netsuite-sync/status", requireNetSuiteMirrorSignature, async (req, res, next) => {
  try {
    res.json(await getNetSuiteMirrorStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/internal/netsuite-sync/events", requireNetSuiteMirrorSignature, async (req, res, next) => {
  try {
    if (!isNetSuiteMirrorConsumer()) return res.status(409).json({ error: "This application is not the NetSuite mirror consumer." });
    if (req.body?.contract !== "netsuite-mirror/v1" || !Array.isArray(req.body?.events)) {
      return res.status(400).json({ error: "Expected a netsuite-mirror/v1 event batch." });
    }
    const accepted = await acceptNetSuiteMirrorEvents(req.body.events);
    kickNetSuiteMirrorConsumer();
    res.status(202).json({ ...accepted, queued: true });
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")
      || !MUTATING_API_METHODS.has(req.method)
      || req.get("x-mbbs-rollback-test") === "1") {
    return next();
  }
  const context = { semanticAuditCount: 0, semanticAuditPromises: [] };
  res.once("finish", () => {
    void writeFallbackMutationAudit(req, res.statusCode, context).catch((error) => {
      console.error("Fallback application audit failed:", error);
    });
  });
  return runWithAuditContext(context, () => next());
});

app.post("/api/webhooks/netsuite/if-ir", async (req, res, next) => {
  try {
    const eventId = req.get("x-mbbs-ifir-event-id") || "";
    const timestamp = req.get("x-mbbs-ifir-timestamp") || "";
    const signature = req.get("x-mbbs-ifir-signature") || "";
    const verified = verifyScmIfIrWebhookSignature({
      rawBody: req.rawBody || "",
      eventId,
      timestamp,
      signature,
      secret: config.netsuite.ifIrWebhookSecret,
      maxAgeSeconds: config.netsuite.ifIrWebhookSignatureMaxAgeSeconds
    });
    if (!verified.ok) {
      return res.status(verified.status || 401).json({ error: verified.error || "Invalid IF/IR webhook signature." });
    }
    if (String(req.body?.schemaVersion || "") !== "mbbs.ifir.reconciliation.v1") {
      return res.status(400).json({ error: "Unsupported IF/IR reconciliation webhook schema." });
    }
    if (req.body?.eventId && String(req.body.eventId) !== String(eventId)) {
      return res.status(400).json({ error: "IF/IR webhook event ID does not match its signed header." });
    }
    const stored = await storeScmIfIrWebhook(req.body || {}, {
      rawBody: req.rawBody || "",
      eventId,
      timestamp
    });
    res.status(202).json({
      accepted: true,
      duplicate: stored.duplicate === true,
      ignored: stored.ignored === true,
      stale: stored.stale === true,
      eventId: stored.eventId || eventId
    });
    void processScmIfIrWebhookResult(stored, {
      operationalSyncRunning: anyNetSuiteSyncRunning
    }).then((result) => {
      if (result?.reconciled) {
        emitAppEvent("dispatch.orders.updated", {
          source: "netsuite-if-ir-webhook",
          orderId: stored.sourceOrderId,
          orderRef: stored.sourceOrderRef || "",
          orderKind: stored.sourceOrderKind || "",
          refreshOrderPool: true
        });
      }
    }).catch(async (error) => {
      console.error("Background IF/IR reconciliation failed:", error);
      await writeAudit({
        actorType: "system",
        source: "netsuite-webhook",
        action: "netsuite.if_ir_reconciliation.failed",
        details: {
          eventId: stored.eventId || eventId,
          sourceOrderKind: stored.sourceOrderKind || "",
          sourceOrderId: stored.sourceOrderId || null,
          error: error.message
        }
      }).catch(() => {});
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/webhooks/netsuite/order", async (req, res, next) => {
  try {
    if (isNetSuiteMirrorConsumer()) return res.status(403).json({ error: "NetSuite webhooks are disabled on the mirror consumer." });
    const expectedSecret = config.netsuite.webhookSecret;
    if (!expectedSecret) return res.status(503).json({ error: "NETSUITE_WEBHOOK_SECRET is not configured on the server." });
    const providedSecret = req.get("x-mbbs-webhook-secret") || req.body?.secret || "";
    const providedBuffer = Buffer.from(String(providedSecret));
    const expectedBuffer = Buffer.from(String(expectedSecret));
    if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      return res.status(401).json({ error: "Invalid webhook secret." });
    }
    const result = await withTransaction(async () => {
      const order = await processNetSuiteOrderWebhook(req.body);
      const poHistory = await processScmNetSuitePoHistoryWebhook(req.body);
      if (poHistory.event) {
        afterTransactionCommit(() => emitAppEvent(poHistory.event.name, poHistory.event.data));
      }
      return {
        ...order,
        appCreatedPoHistoryMatched: poHistory.matched === true
      };
    });
    res.json(result);
  } catch (error) {
    await writeAudit({
      actorType: "system",
      source: "netsuite-webhook",
      action: "netsuite.webhook.failed",
      details: {
        error: error.message,
        netsuiteOrderId: req.body?.id || null,
        tranid: req.body?.tranid || "",
        recordType: req.body?.recordType || req.body?.type || req.body?.orderType || "",
        eventType: req.body?.eventType || ""
      }
    }).catch(() => {});
    next(error);
  }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const client = {
    id: crypto.randomUUID(),
    client: req.query.client || "unknown",
    res
  };
  eventClients.add(client);
  res.write(`retry: 3000\n`);
  res.write(`event: app-event\ndata: ${JSON.stringify({ id: eventSeq, type: "connected", at: new Date().toISOString(), payload: { client: client.client } })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      eventClients.delete(client);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(client);
  });
});

app.use((req, res, next) => {
  if (["/service-worker.js", "/driver-service-worker.js"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Service-Worker-Allowed", "/");
  } else if (["/scm/netsuite-po", "/scm-netsuite-po.html", "/scm/vendors", "/scm-vendors.html"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (req.path === "/mbt" || req.path.startsWith("/mbt/")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (req.path.endsWith(".webmanifest") || ["/", "/operator", "/driver", "/control", "/control/returns", "/admin", "/admin/accounts", "/admin/sync", "/admin/reconciliation", "/admin/printers", "/admin/photo-storage", "/admin/audit", "/admin/return-automation", "/admin/mbt-gates", "/dispatch", "/dispatch/custom-orders", "/dispatch/driver-pwa", "/dispatch/offline-review", "/sales", "/sales/planning", "/sales/schedule", "/sales/monitor", "/sales/printing", "/sales/in-outbound-record", "/sales/returns", "/dispatch/loaded-export", "/dispatch/in-outbound-record", "/control/in-outbound-record", "/dispatch/po-to-schedule", "/scm/smart", "/scm/printers", "/scm/route-rules", "/scm/schedule-formatting", "/operator.html", "/driver.html", "/control.html", "/admin.html", "/dispatch-menu.html", "/dispatch-custom-orders.html", "/dispatch-offline-review.html", "/sales.html", "/sales-printing.html", "/dispatch-loaded-export.html", "/scm-smart.html", "/scm-printers.html", "/scm-route-rules.html", "/scm-schedule-formatting.html"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

app.use("/vendor/qr-scanner", express.static(qrScannerDir));
app.use("/vendor/quagga2", express.static(quaggaScannerDir));
app.use(express.static(publicDir));

const smartScmRawUpload = express.raw({
  type: () => true,
  limit: `${config.smartScm.maxInputMb}mb`
});

function printerAgentId(req) {
  return String(req.get("x-printer-agent-id") || req.body?.agentId || "").trim();
}

function printerAgentVersion(req) {
  return Math.max(1, Number(req.get("x-printer-agent-version") || req.body?.agentVersion || 1) || 1);
}

function printerLeaseToken(req) {
  return String(req.get("x-print-lease-token") || req.body?.leaseToken || req.query?.leaseToken || "").trim();
}

function requiredRawUpload(req) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    throw Object.assign(new Error("Select a non-empty file."), { status: 400 });
  }
  return req.body;
}

// Printer agents intentionally authenticate only against a single yard queue. These
// routes are registered before the staff SCM middleware so agent tokens cannot be
// confused with operator sessions and cannot reach any other application endpoint.
app.post("/api/scm/print-agent/lease", async (req, res, next) => {
  try {
    res.json(await leaseYardPrintJob(bearerToken(req), printerAgentId(req), printerAgentVersion(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/print-agent/jobs/:id/document", async (req, res, next) => {
  try {
    const document = await yardPrintJobDocument(
      req.params.id,
      bearerToken(req),
      printerAgentId(req),
      printerLeaseToken(req)
    );
    res.download(document.path, document.filename, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/print-agent/jobs/:id/:action", async (req, res, next) => {
  try {
    const job = await updateLeasedPrintJob(
      req.params.id,
      bearerToken(req),
      printerAgentId(req),
      printerLeaseToken(req),
      req.params.action,
      req.body || {}
    );
    if (req.params.action !== "heartbeat" && job.documentType === "transfer_dependency_picking_ticket") {
      emitAppEvent("scm.transfer_dependency.updated", {
        source: "transfer-dependency-print-agent",
        printJobId: job.id,
        printStatus: job.status
      });
    }
    if (req.params.action !== "heartbeat" && job.documentType === "sales_order_picking_ticket") {
      emitAppEvent("sales.printing.updated", {
        source: "sales-print-agent",
        printJobId: job.id,
        printStatus: job.status,
        sourceOrderId: job.sourceOrderId
      });
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.use("/api/scm/smart", requireOperator, requireSmartScmAccess);

app.get("/api/scm/smart/bootstrap", async (req, res, next) => {
  try {
    res.json(await getSmartScmBootstrap({ proposalLimit: req.query.proposalLimit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/settings", async (_req, res, next) => {
  try {
    res.json(await getSmartScmSettings());
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/smart/settings", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const settings = await updateSmartScmSettings(req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "settings" });
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/route-rules", async (_req, res, next) => {
  try {
    res.json(await listSmartScmRouteRules());
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/smart/route-rules", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const rule = await upsertSmartScmRouteRule(req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "route-rule", sourceKey: rule.sourceKey });
    res.json(rule);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/model-segments", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const settings = await promoteSmartScmForecastSegment(req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "model-segment" });
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/items/csv-template", async (_req, res, next) => {
  try {
    const csv = await buildSmartScmItemMasterCsvTemplate();
    res.type("text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="smart-scm-item-master-template.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/items/csv", requireSmartScmWriteAccess, smartScmRawUpload, async (req, res, next) => {
  try {
    const summary = await importSmartScmItemMasterCsv({
      buffer: requiredRawUpload(req),
      filename: req.get("x-file-name") || "smart-scm-item-master.csv",
      operatorId: operatorId(req),
      allowReturnPolicyChange: operatorHasAnyRole(req.operator, ["admin"])
    });
    emitAppEvent("scm.smart.updated", {
      source: "item-master-csv",
      itemsUpdated: summary.itemsUpdated,
      yardPoliciesUpdated: summary.yardPoliciesUpdated
    });
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/items", async (req, res, next) => {
  try {
    res.json(await listSmartScmItems({
      search: req.query.search,
      enabled: req.query.enabled,
      vendorYard: req.query.vendorYard,
      lowerStockPolicy: req.query.lowerStockPolicy,
      returnPolicy: req.query.returnPolicy,
      returnPolicyOverride: req.query.returnPolicyOverride || (req.query.overrideOnly === "true" ? "any" : ""),
      limit: req.query.limit,
      offset: req.query.offset
    }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/smart/items/:itemId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    await updateSmartScmItem(req.params.itemId, req.body || {}, operatorId(req), {
      allowReturnPolicyChange: operatorHasAnyRole(req.operator, ["admin"])
    });
    const result = await listSmartScmItems({ search: String(req.params.itemId), limit: 10 });
    emitAppEvent("scm.smart.updated", { source: "item-master", itemId: Number(req.params.itemId) });
    res.json(result.items.find((item) => Number(item.itemId) === Number(req.params.itemId)) || null);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/planning-exclusions", async (req, res, next) => {
  try {
    res.json(await listSmartScmPlanningPauses({
      includeInactive: req.query.includeInactive === "true",
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/planning-exclusions", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const exclusion = await addSmartScmPlanningExclusion(req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "planning-exclusion", exclusionId: exclusion.id, itemId: exclusion.itemId });
    res.status(201).json(exclusion);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/smart/planning-exclusions/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const exclusion = await deactivateSmartScmPlanningExclusion(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "planning-exclusion", exclusionId: exclusion.id, itemId: exclusion.itemId });
    res.json(exclusion);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/blanket-orders", async (req, res, next) => {
  try {
    res.json(await listSmartScmBlanketWorkspace({
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/blanket-plans", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    await refreshSmartScmLiveData({
      fullCatalog: false,
      includeSales: false,
      operatorId: operatorId(req),
      triggerSource: "blanket-planning"
    });
    await runSmartScmForecast({ triggerSource: "blanket-planning", operatorId: operatorId(req) });
    const run = await buildSmartScmBlanketPlan(operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "blanket-planning",
      planningRunId: run.id,
      planKind: "blanket"
    });
    res.status(201).json(run);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/blanket-proposals/:id/confirm", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await confirmSmartScmBlanketProposal(req.params.id, operatorId(req), {
      idempotencyKey: req.body?.idempotencyKey || req.get("idempotency-key") || ""
    });
    const workflow = await getSmartScmVendorWorkflowForProposal(result.proposal.id);
    emitAppEvent("scm.smart.updated", {
      source: "blanket-reserved",
      proposalId: result.proposal.id,
      releaseId: result.release.id,
      workflowId: workflow.workflowId
    });
    res.status(201).json({ ...result, workflow });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/smart/blanket-proposals/:id/lines/:lineId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const proposal = await updateSmartScmBlanketProposalLine(
      req.params.id,
      req.params.lineId,
      req.body || {},
      operatorId(req)
    );
    emitAppEvent("scm.smart.updated", {
      source: "blanket-proposal-line",
      proposalId: proposal.id,
      lineId: Number(req.params.lineId)
    });
    res.json(proposal);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/smart/blanket-releases/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await cancelSmartScmBlanketReservation(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "blanket-reservation-cancelled",
      proposalId: result.proposal.id,
      releaseId: result.release.id
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/sync-status", async (_req, res, next) => {
  try {
    res.json(await getSmartScmSyncStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/sync", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await refreshSmartScmLiveData({
      fullCatalog: req.body?.fullCatalog !== false,
      includeSales: false,
      operatorId: operatorId(req),
      triggerSource: "manual"
    });
    emitAppEvent("scm.smart.updated", { source: "netsuite-sync" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/sales-csv", requireSmartScmWriteAccess, smartScmRawUpload, async (req, res, next) => {
  try {
    const summary = await importSmartScmSalesCsv({
      buffer: requiredRawUpload(req),
      filename: req.get("x-file-name") || "sales.csv",
      operatorId: operatorId(req)
    });
    emitAppEvent("scm.smart.updated", { source: "sales-csv", facts: summary.facts });
    res.status(201).json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/sales-csv/template", (_req, res) => {
  res.type("text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=smart-scm-raw-sales-template.csv");
  res.send("Internal ID,Date,Document Number,Item,Quantity,Delivery Method,Location,Sales Amount,Status\n");
});

app.get("/api/scm/smart/inputs", async (_req, res, next) => {
  try {
    res.json(await listSmartScmInputFiles());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/inputs/:slot", requireSmartScmWriteAccess, smartScmRawUpload, async (req, res, next) => {
  try {
    const file = await storeSmartScmInputFile({
      slot: req.params.slot,
      filename: req.get("x-file-name") || "upload.bin",
      contentType: req.get("content-type") || "application/octet-stream",
      buffer: requiredRawUpload(req),
      operatorId: operatorId(req)
    });
    emitAppEvent("scm.smart.updated", { source: "input-upload", fileId: file.id, slot: file.slot });
    res.status(201).json(file);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/inputs/:id/activate", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const file = await activateSmartScmInputFile(req.params.id, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "input-activate", fileId: file.id, slot: file.slot });
    res.json(file);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/inputs/:id/download", async (req, res, next) => {
  try {
    const file = await smartScmInputDownload(req.params.id);
    res.type(file.contentType);
    res.download(file.path, file.filename, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/forecasts", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    await refreshSmartScmLiveData({
      fullCatalog: false,
      includeSales: false,
      operatorId: operatorId(req),
      triggerSource: "forecast"
    });
    const run = await runSmartScmForecast({ triggerSource: "manual", operatorId: operatorId(req) });
    emitAppEvent("scm.smart.updated", { source: "forecast", forecastRunId: Number(run.id) });
    res.status(201).json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/forecast-runs", async (req, res, next) => {
  try {
    res.json(await listSmartScmForecastRuns({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/forecasts", async (req, res, next) => {
  try {
    res.json(await listSmartScmForecasts({
      runId: req.query.runId,
      search: req.query.search,
      yard: req.query.yard,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/plans", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    await refreshSmartScmLiveData({
      fullCatalog: false,
      includeSales: false,
      operatorId: operatorId(req),
      triggerSource: "planning"
    });
    const forecast = await runSmartScmForecast({ triggerSource: "planning", operatorId: operatorId(req) });
    const run = await runSmartScmPlan({
      triggerSource: "manual",
      operatorId: operatorId(req),
      forecastRunId: Number(forecast.id)
    });
    emitAppEvent("scm.smart.updated", { source: "planning", planningRunId: run.id });
    res.status(201).json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/planning-runs", async (req, res, next) => {
  try {
    res.json(await listSmartScmPlanningRuns({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/planning-runs/:id", async (req, res, next) => {
  try {
    const run = await getSmartScmPlanningRun(req.params.id);
    if (!run) return res.status(404).json({ error: "Smart SCM planning run was not found." });
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/planning-runs/:id/proposals", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const run = await createSmartScmManualLoad(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "manual-proposal-load", planningRunId: run.id });
    res.status(201).json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/manual-load/items", async (req, res, next) => {
  try {
    res.json(await searchSmartScmManualLoadItems({
      proposalType: req.query.proposalType,
      sourceLocationId: req.query.sourceLocationId,
      destinationLocationId: req.query.destinationLocationId,
      search: req.query.search,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/proposals", async (req, res, next) => {
  try {
    res.json(await listSmartScmProposals({
      runId: req.query.runId,
      status: req.query.status,
      type: req.query.type,
      search: req.query.search,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/proposals/group", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const run = await groupSmartScmProposals(req.body?.proposalIds || [], operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "proposal-group", planningRunId: run.id });
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/proposals/:id/recalculate-po", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const run = await recalculateSmartScmPoProposal(req.params.id, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "po-proposal-recalculate", planningRunId: run.id });
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/smart/proposals/:id/pallets/:destinationLocationId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const proposal = await setSmartScmPalletQuantityOverride(req.params.id, req.params.destinationLocationId, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "proposal-pallet-quantity", proposalId: proposal.id });
    res.json(proposal);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/smart/proposals/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const proposal = await updateSmartScmProposal(req.params.id, req.body || {}, operatorId(req));
    if (proposal.proposalType === "PO" && proposal.status === "order_requested") {
      await ensureSmartScmVendorWorkflow(proposal.id, operatorId(req));
    }
    emitAppEvent("scm.smart.updated", { source: "proposal", proposalId: proposal.id });
    res.json(proposal);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/proposals/:id/items", async (req, res, next) => {
  try {
    res.json(await searchSmartScmProposalItems(req.params.id, {
      search: req.query.search,
      destinationLocationId: req.query.destinationLocationId,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/proposals/:id/lines", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const proposal = await addSmartScmProposalLine(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "proposal-line", proposalId: proposal.id });
    res.status(201).json(proposal);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/smart/proposals/:id/lines/:lineId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const proposal = await updateSmartScmProposalLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "proposal-line", proposalId: proposal.id });
    res.json(proposal);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/proposals/:id/lines/:lineId/split", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const run = await splitSmartScmProposalLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "proposal-line-split", proposalId: Number(req.params.id), planningRunId: run.id });
    res.status(201).json(run);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/smart/proposals/:id/lines/:lineId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await removeSmartScmProposalLine(req.params.id, req.params.lineId, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "proposal-line", proposalId: Number(req.params.id), planningRunId: result.runId });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/proposals/:id/confirm-transfer", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    res.status(201).json(await executeSmartScmTransferProposal(req.params.id, req.operator));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/proposals/:id/retry-picking-ticket", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    res.json(await retrySmartScmTransferPrint(req.params.id, req.operator));
  } catch (error) {
    next(error);
  }
});

app.use("/api/scm/netsuite-po-history", requireOperator, requireSmartScmWriteAccess);

app.get("/api/scm/netsuite-po-history/options", async (_req, res, next) => {
  try {
    res.json(await listScmNetSuitePoHistoryFilterOptions());
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/netsuite-po-history", async (req, res, next) => {
  try {
    res.json(await listScmNetSuitePoHistory({
      search: req.query.search,
      createdFrom: req.query.createdFrom,
      createdTo: req.query.createdTo,
      vendorId: req.query.vendorId,
      vendorYard: req.query.vendorYard,
      destinationLocationId: req.query.destinationLocationId,
      page: req.query.page,
      pageSize: req.query.pageSize
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/netsuite-po-history/:id", async (req, res, next) => {
  try {
    res.json(await getScmNetSuitePoHistory(req.params.id, { includeUnarchived: false }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/netsuite-po-history/:id", async (req, res, next) => {
  try {
    const history = await updateScmNetSuitePoHistory(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "netsuite-po-history-edit",
      historyId: history.id,
      purchaseOrderId: history.purchaseOrderId,
      purchaseOrderRef: history.purchaseOrderRef
    });
    emitAppEvent("receiving.order.updated", {
      source: "netsuite-po-history-edit",
      orderId: history.purchaseOrderId,
      orderRef: history.purchaseOrderRef
    });
    res.json(history);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/netsuite-po-history/:id/refresh", async (req, res, next) => {
  try {
    const history = await refreshScmNetSuitePoHistory(req.params.id, {
      source: "reconciliation",
      operatorId: operatorId(req)
    });
    emitAppEvent("scm.smart.updated", {
      source: "netsuite-po-history-refresh",
      historyId: history.id,
      purchaseOrderId: history.purchaseOrderId,
      purchaseOrderRef: history.purchaseOrderRef
    });
    res.json(history);
  } catch (error) {
    next(error);
  }
});

for (const archived of [true, false]) {
  app.post(`/api/scm/netsuite-po-history/:id/${archived ? "archive" : "unarchive"}`, async (req, res, next) => {
    try {
      const history = await setScmNetSuitePoHistoryArchived(req.params.id, archived, operatorId(req));
      emitAppEvent("scm.smart.updated", {
        source: archived ? "netsuite-po-history-archive" : "netsuite-po-history-unarchive",
        historyId: history.id,
        purchaseOrderId: history.purchaseOrderId,
        purchaseOrderRef: history.purchaseOrderRef
      });
      res.json(history);
    } catch (error) {
      next(error);
    }
  });
}

app.get("/api/scm/netsuite-po-history/:id/pdf", async (req, res, next) => {
  try {
    const document = await getScmNetSuitePoHistoryPdf(req.params.id);
    res.type(document.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(document.filename || "purchase-order.pdf").replace(/[\r\n\"]/g, "-")}"`);
    res.send(document.buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/vendor-workflows/:id", async (req, res, next) => {
  try {
    res.json(await getSmartScmVendorWorkflow(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/smart/vendor-workflows/:id/email-draft", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const workflow = await saveSmartScmVendorEmailDraft(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "vendor-email-draft",
      workflowId: workflow.workflowId,
      proposalId: workflow.sourceProposalId
    });
    res.json(workflow);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/vendor-workflows/:id/create-purchase-order", requireSmartScmWriteAccess, async (req, res, next) => {
  let target = null;
  try {
    target = await getSmartScmVendorWorkflowActionTarget(req.params.id);
    if (target.workflowKind !== "regular_po") {
      throw Object.assign(new Error("Blanket releases create a local split PO and never create another NetSuite purchase order."), { status: 409 });
    }
    if (target.netsuitePurchaseOrderId || target.netsuitePurchaseOrderRef) {
      const review = target.reviewProposalId
        ? await getSmartScmNetSuitePoReviewLoad(target.reviewProposalId)
        : null;
      if (!review || review.status === "completed") {
        let history = target.netsuitePurchaseOrderId
          ? await findScmNetSuitePoHistoryByNetSuiteId(target.netsuitePurchaseOrderId)
          : null;
        if (!history && target.netsuitePurchaseOrderId) {
          history = await registerScmNetSuitePoHistoryCreation({
            proposalId: target.reviewProposalId || target.sourceProposalId,
            purchaseOrderId: target.netsuitePurchaseOrderId,
            purchaseOrderRef: target.netsuitePurchaseOrderRef
          }, operatorId(req));
        }
        const workflow = await recordSmartScmVendorWorkflowPurchaseResult(target.workflowId, {
          reviewProposalId: target.reviewProposalId,
          purchaseOrderId: target.netsuitePurchaseOrderId,
          purchaseOrderRef: target.netsuitePurchaseOrderRef
        }, operatorId(req));
        return res.json({
          reused: true,
          proposalId: target.reviewProposalId,
          purchaseOrderId: target.netsuitePurchaseOrderId,
          purchaseOrderRef: target.netsuitePurchaseOrderRef,
          workflow,
          history
        });
      }
    }
    let reviewProposalId = target.reviewProposalId;
    if (!reviewProposalId) {
      const vendorReply = req.body?.vendorReply || req.body || {};
      const hasConfirmedLine = Array.isArray(vendorReply.lines) && vendorReply.lines.some((line) =>
        String(line?.decision || "").toLowerCase() === "confirm"
        && Number(line?.decisionPallets ?? line?.confirmedPallets) > 0
      );
      if (!hasConfirmedLine) {
        throw Object.assign(new Error("Confirm at least one vendor line above 0 PLT before creating a NetSuite purchase order."), { status: 400 });
      }
      const staged = await stageSmartScmVendorReplyLoad(
        target.sourceProposalId,
        vendorReply,
        operatorId(req)
      );
      if (!staged.reviewProposalId) {
        throw Object.assign(new Error("At least one vendor line must be confirmed before creating a NetSuite purchase order."), { status: 409 });
      }
      reviewProposalId = staged.reviewProposalId;
      await linkSmartScmVendorWorkflowReview(target.workflowId, reviewProposalId, operatorId(req));
    }
    const result = await executeSmartScmPurchaseProposal(reviewProposalId, operatorId(req));
    const history = result.purchaseOrderId
      ? await registerScmNetSuitePoHistoryCreation({
          proposalId: result.proposalId || reviewProposalId,
          purchaseOrderId: result.purchaseOrderId,
          purchaseOrderRef: result.purchaseOrderRef
        }, operatorId(req))
      : null;
    const workflow = await recordSmartScmVendorWorkflowPurchaseResult(target.workflowId, {
      ...result,
      reviewProposalId
    }, operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "vendor-workflow-purchase-created",
      workflowId: workflow.workflowId,
      proposalId: result.proposalId || reviewProposalId,
      purchaseOrderId: result.purchaseOrderId,
      purchaseOrderRef: result.purchaseOrderRef
    });
    if (result.purchaseOrderId) {
      emitAppEvent("dispatch.orders.updated", {
        source: "vendor-workflow-purchase-created",
        refreshOrderPool: true,
        orderId: result.purchaseOrderId,
        orderRef: result.purchaseOrderRef
      });
    }
    res.status(result.reused ? 200 : 201).json({ ...result, workflow, history });
  } catch (error) {
    if (target?.workflowId) {
      await recordSmartScmVendorWorkflowAttention(target.workflowId, error, operatorId(req)).catch(() => null);
    }
    next(error);
  }
});

app.post("/api/scm/smart/vendor-workflows/:id/create-blanket-split", requireSmartScmWriteAccess, async (req, res, next) => {
  let target = null;
  try {
    target = await getSmartScmVendorWorkflowActionTarget(req.params.id);
    if (target.workflowKind !== "blanket_po") {
      throw Object.assign(new Error("Only a Blanket Vendor Replies workflow can create a local split purchase order."), { status: 409 });
    }
    if (target.splitPurchaseOrderRef && target.workflowStatus === "split_created") {
      return res.json({
        reused: true,
        splitPurchaseOrderId: target.splitPurchaseOrderId,
        splitPurchaseOrderRef: target.splitPurchaseOrderRef,
        workflow: await getSmartScmVendorWorkflow(target.workflowId)
      });
    }
    const result = await finalizeSmartScmBlanketVendorWorkflow(
      target.sourceProposalId,
      req.body || {},
      operatorId(req)
    );
    const workflow = await recordSmartScmVendorWorkflowBlanketSplit(
      target.workflowId,
      result,
      operatorId(req)
    );
    const splitPurchaseOrderRef = result.release?.splitPoRef
      || result.split?.split?.splitPoRef
      || workflow.splitPurchaseOrderRef
      || "";
    emitAppEvent("scm.smart.updated", {
      source: "blanket-split-created",
      workflowId: workflow.workflowId,
      proposalId: result.proposal?.id || target.sourceProposalId,
      releaseId: result.release?.id,
      splitPurchaseOrderRef,
      releaseStatus: result.release?.status
    });
    emitAppEvent("dispatch.orders.updated", {
      source: "blanket-split-created",
      refreshOrderPool: true,
      orderRef: splitPurchaseOrderRef
    });
    res.status(result.idempotent ? 200 : 201).json({
      ...result,
      splitPurchaseOrderRef,
      workflow
    });
  } catch (error) {
    if (target?.workflowId) {
      await recordSmartScmVendorWorkflowAttention(target.workflowId, error, operatorId(req)).catch(() => null);
    }
    next(error);
  }
});

app.patch("/api/scm/smart/vendor-workflows/:id/archive", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const workflow = await getSmartScmVendorWorkflow(req.params.id);
    if (workflow.workflowKind !== "regular_po" || !workflow.netsuitePurchaseOrderId) {
      throw Object.assign(new Error("Only a created regular NetSuite purchase order can move to PO history."), { status: 409 });
    }
    let history = await findScmNetSuitePoHistoryByNetSuiteId(workflow.netsuitePurchaseOrderId);
    if (!history) {
      history = await registerScmNetSuitePoHistoryCreation({
        proposalId: workflow.reviewProposalId || workflow.sourceProposalId,
        purchaseOrderId: workflow.netsuitePurchaseOrderId,
        purchaseOrderRef: workflow.netsuitePurchaseOrderRef
      }, operatorId(req));
    }
    const archived = req.body?.archived !== false;
    history = await setScmNetSuitePoHistoryArchived(history.id, archived, operatorId(req));
    const updatedWorkflow = await getSmartScmVendorWorkflow(req.params.id);
    emitAppEvent("scm.smart.updated", {
      source: archived ? "vendor-workflow-archived" : "vendor-workflow-unarchived",
      workflowId: updatedWorkflow.workflowId,
      historyId: history.id,
      purchaseOrderId: history.purchaseOrderId,
      purchaseOrderRef: history.purchaseOrderRef
    });
    res.json({ workflow: updatedWorkflow, history });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/vendor-workflows/:id/purchase-order.pdf", async (req, res, next) => {
  try {
    const workflow = await getSmartScmVendorWorkflow(req.params.id);
    if (!workflow.netsuitePurchaseOrderId) {
      throw Object.assign(new Error("This workflow does not have a real NetSuite purchase order to preview."), { status: 409 });
    }
    const history = await findScmNetSuitePoHistoryByNetSuiteId(workflow.netsuitePurchaseOrderId);
    if (!history) throw Object.assign(new Error("The app-created purchase order is not registered in PO history yet."), { status: 409 });
    const document = await getScmNetSuitePoHistoryPdf(history.id);
    res.type(document.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(document.filename || "purchase-order.pdf").replace(/[\r\n\"]/g, "-")}"`);
    res.send(document.buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/vendor-reply-loads", async (req, res, next) => {
  try {
    res.json(await listSmartScmVendorWorkflowLoads({ search: req.query.search, limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/smart/vendor-reply-loads/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const current = await getSmartScmProposal(req.params.id);
    if (!current) return res.status(404).json({ error: "Vendor Replies proposal was not found." });
    const proposal = current.proposalOrigin === "blanket"
      ? await saveSmartScmBlanketVendorReplyDraft(req.params.id, req.body || {}, operatorId(req))
      : await saveSmartScmVendorReplyLoad(req.params.id, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "vendor-reply-load", proposalId: proposal.id, planningRunId: proposal.runId });
    res.json(await getSmartScmVendorWorkflowForProposal(proposal.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/smart/vendor-reply-loads/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const current = await getSmartScmProposal(req.params.id);
    if (!current) return res.status(404).json({ error: "Vendor Replies proposal was not found." });
    if (current.proposalOrigin === "blanket") {
      const result = await cancelSmartScmBlanketReservationForProposal(req.params.id, req.body || {}, operatorId(req));
      const currentWorkflow = await getSmartScmVendorWorkflowForProposal(current.id);
      const workflow = await recordSmartScmVendorWorkflowBlanketSplit(
        currentWorkflow.workflowId,
        result,
        operatorId(req)
      );
      emitAppEvent("scm.smart.updated", {
        source: "blanket-vendor-load-removed",
        proposalId: current.id,
        releaseId: result.release?.id,
        workflowId: workflow.workflowId
      });
      return res.json({ ...result, workflow });
    }
    const result = await removeSmartScmVendorReplyLoad(req.params.id, operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "vendor-reply-load-removed",
      proposalId: result.id,
      planningRunId: result.runId
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/vendor-reply-loads/:id/alternatives", async (req, res, next) => {
  try {
    const proposal = await getSmartScmProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: "Vendor Replies proposal was not found." });
    res.json(proposal.proposalOrigin === "blanket"
      ? await searchSmartScmBlanketAlternatives(req.params.id, {
          search: req.query.search,
          limit: req.query.limit
        })
      : await searchSmartScmVendorAlternatives(req.params.id, {
          search: req.query.search,
          lineId: req.query.lineId,
          limit: req.query.limit
        }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/vendor-reply-loads/:id/lines", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const current = await getSmartScmProposal(req.params.id);
    if (!current) return res.status(404).json({ error: "Vendor Replies proposal was not found." });
    const result = current.proposalOrigin === "blanket"
      ? await addSmartScmBlanketAlternativeLine(req.params.id, req.body || {}, operatorId(req))
      : await addSmartScmVendorAlternativeLine(req.params.id, req.body || {}, operatorId(req));
    const proposal = result.proposal || result;
    const workflow = await getSmartScmVendorWorkflowForProposal(proposal.id);
    emitAppEvent("scm.smart.updated", { source: "vendor-alternative-add", proposalId: proposal.id, planningRunId: proposal.runId });
    res.status(201).json(workflow);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/smart/vendor-reply-loads/:id/lines/:lineId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const current = await getSmartScmProposal(req.params.id);
    if (!current) return res.status(404).json({ error: "Vendor Replies proposal was not found." });
    const result = current.proposalOrigin === "blanket"
      ? await removeSmartScmBlanketAlternativeLine(req.params.id, req.params.lineId, operatorId(req))
      : await removeSmartScmVendorAlternativeLine(req.params.id, req.params.lineId, operatorId(req));
    const proposal = result.proposal || result;
    const workflow = await getSmartScmVendorWorkflowForProposal(proposal.id);
    emitAppEvent("scm.smart.updated", { source: "vendor-alternative-remove", proposalId: proposal.id, planningRunId: proposal.runId });
    res.json(workflow);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/vendor-reply-loads/:id/confirm", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const current = await getSmartScmProposal(req.params.id);
    if (!current) return res.status(404).json({ error: "Vendor Replies proposal was not found." });
    if (current.proposalOrigin === "blanket") {
      const result = await finalizeSmartScmBlanketVendorWorkflow(req.params.id, req.body || {}, operatorId(req));
      const currentWorkflow = await getSmartScmVendorWorkflowForProposal(current.id);
      const workflow = await recordSmartScmVendorWorkflowBlanketSplit(
        currentWorkflow.workflowId,
        result,
        operatorId(req)
      );
      emitAppEvent("scm.smart.updated", {
        source: "blanket-vendor-finalized",
        proposalId: current.id,
        releaseId: result.release?.id,
        workflowId: workflow.workflowId
      });
      return res.status(result.idempotent ? 200 : 201).json({ ...result, workflow });
    }
    const result = await stageSmartScmVendorReplyLoad(req.params.id, req.body || {}, operatorId(req));
    const workflow = await getSmartScmVendorWorkflowForProposal(result.sourceProposalId);
    if (result.reviewProposalId) {
      await linkSmartScmVendorWorkflowReview(workflow.workflowId || workflow.id, result.reviewProposalId, operatorId(req));
    }
    const messages = [];
    if (result.reviewProposalId) messages.push("Confirmed lines were staged for NetSuite PO review.");
    else messages.push("Vendor decisions were applied. No NetSuite PO review was created.");
    if (result.heldProposalIds?.length) messages.push(`${result.heldProposalIds.length} held line(s) were split into separate Vendor Replies loads.`);
    if (result.cancelledProposalId) messages.push("Cancelled and unused Hold quantities were finalized at 0 PLT with history retained.");
    emitAppEvent("scm.smart.updated", {
      source: "vendor-reply-staged",
      proposalId: result.sourceProposalId,
      planningRunId: result.runId,
      reviewProposalId: result.reviewProposalId,
      cancelledProposalId: result.cancelledProposalId,
      heldProposalIds: result.heldProposalIds
    });
    res.status(201).json({
      ...result,
      message: messages.join(" ")
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/netsuite-purchase-orders", async (req, res, next) => {
  try {
    res.json(await listSmartScmNetSuitePoReviewLoads({
      search: req.query.search,
      view: req.query.view,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scm/smart/netsuite-purchase-orders/:id/pallets/:destinationLocationId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const review = await updateSmartScmNetSuitePoReviewPalletQuantity(
      req.params.id,
      req.params.destinationLocationId,
      req.body || {},
      operatorId(req)
    );
    emitAppEvent("scm.smart.updated", {
      source: "netsuite-po-pallet-override",
      proposalId: review.id,
      planningRunId: review.runId,
      destinationLocationId: Number(req.params.destinationLocationId)
    });
    res.json(review);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/smart/netsuite-purchase-orders/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await removeSmartScmNetSuitePoReviewLoad(req.params.id, operatorId(req));
    emitAppEvent("scm.smart.updated", {
      source: "netsuite-po-review-removed",
      proposalId: result.id,
      planningRunId: result.runId
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/netsuite-purchase-orders/:id/insert", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await executeSmartScmPurchaseProposal(req.params.id, operatorId(req));
    const history = result.purchaseOrderId
      ? await registerScmNetSuitePoHistoryCreation({
          proposalId: result.proposalId || Number(req.params.id),
          purchaseOrderId: result.purchaseOrderId,
          purchaseOrderRef: result.purchaseOrderRef
        }, operatorId(req))
      : null;
    const workflow = await findSmartScmVendorWorkflowByPurchaseOrder({
      purchaseOrderId: result.purchaseOrderId,
      reviewProposalId: result.proposalId || Number(req.params.id)
    });
    if (workflow) {
      await recordSmartScmVendorWorkflowPurchaseResult(workflow.id, {
        ...result,
        reviewProposalId: result.proposalId || Number(req.params.id)
      }, operatorId(req));
    }
    emitAppEvent("scm.smart.updated", { source: "smart-scm-purchase", proposalId: result.proposalId, purchaseOrderId: result.purchaseOrderId, purchaseOrderRef: result.purchaseOrderRef });
    if (result.purchaseOrderId) emitAppEvent("dispatch.orders.updated", { source: "smart-scm-purchase", refreshOrderPool: true });
    res.status(result.reused ? 200 : 201).json({ ...result, history });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/vendor-responses", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const run = await recordSmartScmVendorResponses(req.body?.responses || req.body || [], operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "vendor-response", planningRunId: run.id });
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/vendor-responses/import", requireSmartScmWriteAccess, smartScmRawUpload, async (req, res, next) => {
  try {
    const responses = await parseSmartScmVendorResponseFile(
      requiredRawUpload(req),
      req.get("x-file-name") || "vendor-responses.csv"
    );
    const run = await recordSmartScmVendorResponses(responses, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "vendor-response-import", planningRunId: run.id });
    res.json({ imported: responses.length, run });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/vendor-responses/template", async (req, res, next) => {
  try {
    const proposals = await listSmartScmProposals({
      runId: req.query.runId,
      type: "PO",
      statuses: ["order_requested", "vendor_replied", "executing", "attention", "failed", "completed"],
      requestedOnly: true,
      limit: 2000
    });
    const header = ["Proposal Line ID", "Response Status", "Confirmed Pallets", "Unavailable Pallets", "Ready Date", "Vendor Reference", "Packing Number", "Credit Status", "Remarks"];
    const rows = proposals.flatMap((proposal) => proposal.lines.map((line) => [
      line.id, "awaiting", "", "", "", "", "", "", `${proposal.vendor || proposal.sourceName || ""} | ${line.itemName}`
    ]));
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=smart-scm-vendor-responses.csv");
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/printers", async (_req, res, next) => {
  try {
    res.json(await listYardPrinters());
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/smart/printers/:locationId", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const printer = await updateYardPrinter(req.params.locationId, req.body || {}, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "printer", locationId: printer.locationId });
    res.json(printer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/printers/:locationId/token", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const result = await rotateYardPrinterToken(req.params.locationId, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "printer-token", locationId: result.printer.locationId });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/printers/:locationId/test", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const job = await queueYardPrinterTest(req.params.locationId, operatorId(req), req.body?.printerSlot);
    emitAppEvent("scm.smart.updated", { source: "printer-test", printJobId: job.id });
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/smart/print-jobs", async (req, res, next) => {
  try {
    res.json(await listSmartScmPrintJobs({
      locationId: req.query.locationId,
      status: req.query.status,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/smart/print-jobs/:id/retry", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const job = await retrySmartScmPrintJob(req.params.id, operatorId(req));
    emitAppEvent("scm.smart.updated", { source: "print-retry", printJobId: job.id });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/public-access", async (_req, res, next) => {
  try {
    const settings = await getSalesPortalSettings();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      enabled: settings.enabled,
      operator: settings.enabled ? publicSalesOperator() : null
    });
  } catch (error) {
    next(error);
  }
});

app.use("/api/scm", requireOperator, requireScmAccess);
app.use("/api/dispatch", requireOperatorOrPublicSalesRead, requireDispatchAccess);
app.use("/api/sales", requireSalesOperator, requireSalesAccess);
app.use("/api/mbt", requireOperator, createMbtRouter());

app.get("/api/dispatch/offline-review/count", requireDispatcher, async (_req, res, next) => {
  try {
    const [serverCounts, clientSyncIssues] = await Promise.all([
      getDriverOfflineReviewCounts(),
      listDriverClientSyncIssues({ limit: 500 })
    ]);
    const clientSyncIssueCount = clientSyncIssues.length;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      count: serverCounts.serverSyncCount + clientSyncIssueCount,
      serverSyncCount: serverCounts.serverSyncCount,
      clientSyncIssueCount,
      actionRequiredCount: serverCounts.actionRequiredCount + clientSyncIssueCount,
      serverActionRequiredCount: serverCounts.actionRequiredCount,
      syncInProgressCount: serverCounts.syncInProgressCount,
      byStatus: serverCounts.byStatus,
      photoCounts: serverCounts.photoCounts
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/offline-review/device-issues/:sessionId/dismiss", requireDispatcher, async (req, res, next) => {
  try {
    const operatorName = req.operator?.username
      || req.operator?.display_name
      || String(req.operator?.id || "dispatcher");
    const result = await withTransaction(async () => {
      const dismissal = await dismissDriverClientSyncIssue({
        sessionId: req.params.sessionId,
        expectedReportedAt: req.body?.expectedReportedAt
          || req.body?.expectedReportTimestamp
          || req.body?.reportedAt,
        auditNote: req.body?.auditNote,
        dismissedBy: operatorName
      });
      if (!dismissal.idempotentReplay) {
        const issue = dismissal.issue;
        await writeDispatchAudit({
          action: "driver_client_sync_issue_dismissed",
          entityType: "driver_session",
          entityId: issue.sessionId,
          sessionId: issue.sessionId,
          planDate: issue.planDate || null,
          operatorId: req.operator?.id || null,
          operatorName,
          source: "dispatch_offline_review",
          before: {
            state: issue.state,
            errorName: issue.errorName,
            errorCode: issue.errorCode,
            errorMessage: issue.errorMessage,
            manifestId: issue.manifestId,
            pendingEventCount: issue.pendingEventCount,
            reviewRequiredCount: issue.reviewRequiredCount,
            unsyncedPhotoCount: issue.unsyncedPhotoCount,
            clientOccurredAt: issue.clientOccurredAt,
            reportedAt: issue.reportedAt
          },
          after: {
            dismissed: true,
            reportReceivedAt: issue.dismissal?.reportReceivedAt,
            dismissedAt: issue.dismissal?.dismissedAt,
            dismissedBy: issue.dismissal?.dismissedBy
          },
          details: {
            auditNote: issue.dismissal?.auditNote,
            driverLogin: issue.driverLogin,
            deviceId: issue.deviceId,
            telemetryPreserved: true
          }
        });
      }
      return dismissal;
    });
    if (!result.idempotentReplay) {
      emitAppEvent("driver.offline.device_issue.dismissed", {
        sessionId: result.issue.sessionId,
        driverLogin: result.issue.driverLogin,
        deviceId: result.issue.deviceId,
        reportedAt: result.issue.reportedAt
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/driver-pwa/stops", requireDispatcher, async (req, res, next) => {
  try {
    const planDate = req.query.planDate || req.query.date || "";
    const driverLogin = req.query.driverLogin || "";
    const [result, clientSyncIssues] = await Promise.all([
      listDriverPwaStops({
        planDate,
        driverLogin,
        limit: req.query.limit || 200
      }),
      listDriverClientSyncIssues({
        planDate,
        driverLogin,
        limit: req.query.limit || 200
      })
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...result,
      clientSyncIssues,
      clientSyncIssueCount: clientSyncIssues.length
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/driver-pwa/stops/:recordId/reopen", requireDispatcher, async (req, res, next) => {
  try {
    const result = await reopenDriverPwaStop({
      recordId: req.params.recordId,
      expectedStateHash: req.body?.expectedStateHash,
      auditNote: req.body?.auditNote,
      idempotencyId: req.body?.idempotencyId,
      reopenedBy: req.operator?.username
        || req.operator?.display_name
        || String(req.operator?.id || "dispatcher")
    });
    emitAppEvent("driver.job.reopened", {
      source: "driver_pwa",
      driverLogin: result.driverLogin,
      planDate: result.planDate,
      jobId: result.jobId,
      correctionId: result.correctionId
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/offline-review", requireDispatcher, async (req, res, next) => {
  try {
    const status = req.query.status || "open";
    const driverLogin = req.query.driverLogin || "";
    const planDate = req.query.planDate || "";
    const [result, clientSyncIssues] = await Promise.all([
      listDriverOfflineReviews({
        status,
        limit: req.query.limit || 100,
        offset: req.query.offset || req.query.cursor || 0,
        driverLogin,
        planDate
      }),
      status === "open" || status === "all"
        ? listDriverClientSyncIssues({
            planDate,
            driverLogin,
            limit: 500
          })
        : Promise.resolve([])
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...result,
      clientSyncIssues,
      clientSyncIssueCount: clientSyncIssues.length,
      nextCursor: result.nextOffset === null ? null : String(result.nextOffset)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/offline-review/:eventId/photos/:photoId", requireDispatcher, async (req, res, next) => {
  try {
    const detail = await getDriverOfflineReview(req.params.eventId);
    if (!detail?.case) return res.status(404).json({ error: "Offline review case was not found." });
    const photo = (detail.case.photos || []).find((entry) =>
      String(entry.photoId) === String(req.params.photoId)
    );
    if (!photo) return res.status(404).json({ error: "Offline evidence photo was not found." });
    if (!photo.durableReceipt || !photo.objectReference) {
      return res.status(409).json({ error: "Offline evidence photo has not been durably received." });
    }
    const archived = await readArchivedPhoto(photo.objectReference);
    if (archived?.available) {
      res.setHeader("Content-Type", archived.contentType);
      res.setHeader("Content-Length", String(archived.byteSize));
      res.setHeader("ETag", `"${archived.sha256}"`);
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(archived.bytes);
    }
    const readTicket = createPhotoReadToken({
      actor: {
        id: req.operator?.id,
        username: req.operator?.username,
        role: req.operator?.role
      },
      key: photo.objectReference
    });
    const response = await fetch(readTicket.objectUrl, {
      headers: { Authorization: `Bearer ${readTicket.token}` }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return res.status(response.status).json({ error: text || "Offline evidence photo could not be read." });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", response.headers.get("content-type") || photo.mimeType || "image/jpeg");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/offline-review/:eventId", requireDispatcher, async (req, res, next) => {
  try {
    const detail = await driverOfflineReviewWithCurrentPlan(req.params.eventId);
    if (!detail) return res.status(404).json({ error: "Offline review case was not found." });
    res.setHeader("Cache-Control", "no-store");
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

function publicDriverOfflineQueueResults(events = []) {
  return (events || []).map((event) => ({
    eventId: event.eventId,
    clientSequence: Number(event.clientSequence || 0),
    status: event.status,
    effectiveJobId: event.effectiveJobId || "",
    reviewReason: event.reviewReason || "",
    result: event.result || {}
  }));
}

async function drainDriverOfflineDeviceStream({
  driverLogin,
  planDate,
  deviceId,
  emissionSource
}) {
  const events = await processDriverOfflineQueue({
    driverLogin,
    planDate,
    deviceId,
    allowBlocked: true,
    applyEvent: (context) => applyDriverOfflineEvent({
      ...context,
      emissionSource
    })
  });
  return publicDriverOfflineQueueResults(events);
}

app.post("/api/dispatch/offline-review/:eventId/retry", requireDispatcher, async (req, res, next) => {
  let activeRetryId = "";
  try {
    const operatorName = req.operator?.username
      || req.operator?.display_name
      || String(req.operator?.id || "dispatcher");
    const retryId = String(req.body?.retryId || req.body?.idempotencyId || "").trim().toLowerCase();
    const alternateRetryId = String(req.body?.idempotencyId || req.body?.retryId || "").trim().toLowerCase();
    if (retryId && alternateRetryId && retryId !== alternateRetryId) {
      throw Object.assign(new Error("Retry ID and idempotency ID must match."), {
        status: 400,
        code: "OFFLINE_RETRY_IDEMPOTENCY_CONFLICT"
      });
    }
    const caseVersion = req.body?.caseVersion ?? req.body?.expectedVersion;
    if (
      req.body?.caseVersion !== undefined
      && req.body?.expectedVersion !== undefined
      && Number(req.body.caseVersion) !== Number(req.body.expectedVersion)
    ) {
      throw Object.assign(new Error("Case version and expected version must match."), {
        status: 400,
        code: "OFFLINE_RETRY_VERSION_CONFLICT"
      });
    }
    const prepared = await beginDriverOfflineRetry({
      eventId: req.params.eventId,
      caseVersion,
      retryId,
      requestedBy: operatorName
    });
    if (prepared.replay) {
      const replayPayload = {
        ...(prepared.result || {}),
        retryId: prepared.retry.retryId,
        idempotentReplay: true
      };
      return prepared.retry.status === "failed"
        ? res.status(409).json(replayPayload)
        : res.json(replayPayload);
    }
    activeRetryId = prepared.retry.retryId;
    const event = prepared.event;
    const sourceStatus = event.status;
    const results = [];
    for (const photo of event.photos || []) {
      if (photo.durableReceipt) {
        results.push({
          photoId: photo.photoId,
          status: "already_durable",
          verificationAttemptCount: Number(photo.verificationAttemptCount || 0)
        });
        continue;
      }
      if (!photo.objectReference) {
        const errorCode = "OFFLINE_PHOTO_UPLOAD_MISSING";
        const errorMessage = "No uploaded object is available. The Driver device must reconnect with its retained local photo, or Dispatch must close the stale event as evidence only.";
        const stored = await recordDriverOfflinePhotoVerificationFailure(photo.photoId, {
          errorCode,
          errorMessage
        });
        results.push({
          photoId: photo.photoId,
          status: "missing_upload",
          errorCode,
          error: errorMessage,
          verificationAttemptCount: stored.verificationAttemptCount,
          attemptedAt: stored.lastVerificationAttemptAt
        });
        continue;
      }
      try {
        const verified = await verifyDriverOfflinePhotoObject(photo, {
          id: req.operator?.id || operatorName,
          username: req.operator?.username || "",
          role: req.operator?.role || "dispatcher"
        });
        const stored = await markDriverOfflinePhotoDurable(photo.photoId, {
          objectReference: photo.objectReference,
          ...verified
        });
        results.push({
          photoId: photo.photoId,
          status: "verified",
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          verificationAttemptCount: stored.verificationAttemptCount,
          attemptedAt: stored.lastVerificationAttemptAt
        });
      } catch (error) {
        const errorCode = String(error?.code || "OFFLINE_PHOTO_VERIFICATION_FAILED").slice(0, 160);
        const errorMessage = String(error?.message || error || "Photo durability verification failed.").slice(0, 2000);
        const stored = await recordDriverOfflinePhotoVerificationFailure(photo.photoId, {
          errorCode,
          errorMessage
        });
        results.push({
          photoId: photo.photoId,
          status: "failed",
          errorCode,
          error: errorMessage,
          verificationAttemptCount: stored.verificationAttemptCount,
          attemptedAt: stored.lastVerificationAttemptAt
        });
      }
    }

    let drained = [];
    let drainError = null;
    try {
      drained = await drainDriverOfflineDeviceStream({
        driverLogin: event.driverLogin,
        planDate: event.planDate,
        deviceId: event.deviceId,
        emissionSource: "offline_review_retry"
      });
    } catch (error) {
      drainError = {
        code: String(error?.code || "OFFLINE_QUEUE_RETRY_FAILED").slice(0, 160),
        error: String(error?.message || error || "The device event queue could not be retried.").slice(0, 2000)
      };
    }
    const refreshedEvent = await getDriverOfflineEvent(event.eventId);
    const summary = {
      total: results.length,
      alreadyDurable: results.filter((photo) => photo.status === "already_durable").length,
      verified: results.filter((photo) => photo.status === "verified").length,
      failed: results.filter((photo) => photo.status === "failed").length,
      missingUploads: results.filter((photo) => photo.status === "missing_upload").length,
      results
    };
    await writeDispatchAudit({
      action: "driver_offline_sync_retry",
      entityType: "driver_offline_event",
      entityId: event.eventId,
      planDate: event.planDate,
      operatorId: req.operator?.id || null,
      operatorName,
      source: "dispatch_offline_review",
      before: { status: sourceStatus },
      after: { status: refreshedEvent?.status || sourceStatus },
      details: {
        driverLogin: event.driverLogin,
        deviceId: event.deviceId,
        retryId: activeRetryId,
        photoVerifiedCount: summary.verified,
        photoFailedCount: summary.failed,
        photoMissingUploadCount: summary.missingUploads,
        resultingQueueStatuses: drained.map((entry) => ({
          eventId: entry.eventId,
          status: entry.status
        })),
        drainError
      }
    });
    const responsePayload = {
      retryId: activeRetryId,
      idempotentReplay: false,
      eventId: event.eventId,
      driverLogin: event.driverLogin,
      planDate: event.planDate,
      deviceId: event.deviceId,
      sourceStatus,
      status: refreshedEvent?.status || sourceStatus,
      photos: summary,
      drained,
      ...(drainError ? { drainError } : {}),
      event: refreshedEvent
    };
    await completeDriverOfflineRetry(activeRetryId, responsePayload);
    emitAppEvent("driver.offline.review.retried", {
      eventId: event.eventId,
      driverLogin: event.driverLogin,
      deviceId: event.deviceId,
      sourceStatus,
      status: refreshedEvent?.status || sourceStatus,
      verifiedPhotoCount: summary.verified,
      failedPhotoCount: summary.failed,
      missingUploadPhotoCount: summary.missingUploads
    });
    res.json(responsePayload);
  } catch (error) {
    if (activeRetryId) await failDriverOfflineRetry(activeRetryId, error).catch(() => null);
    next(error);
  }
});

app.post("/api/dispatch/offline-review/:eventId/resolve", requireDispatcher, async (req, res, next) => {
  try {
    const result = await resolveDriverOfflineReview({
      eventId: req.params.eventId,
      action: req.body?.action,
      targetJobId: req.body?.targetJobId || "",
      auditNote: req.body?.auditNote,
      caseVersion: req.body?.caseVersion ?? req.body?.expectedVersion,
      idempotencyId: req.body?.idempotencyId || req.body?.resolutionId,
      resolvedBy: req.operator?.username || req.operator?.display_name || String(req.operator?.id || "dispatcher"),
      confirmed: req.body?.confirmed === true
    }, {
      applyResolution: applyDriverOfflineReviewResolution,
      replayBlocked: async ({ driverLogin, planDate, deviceId, blockedEvents }) => {
        const blockedEventIds = new Set(blockedEvents.map((event) => String(event.eventId)));
        const replayed = await processDriverOfflineQueue({
          driverLogin,
          planDate,
          deviceId,
          applyEvent: (context) => applyDriverOfflineEvent({
            ...context,
            emissionSource: "offline_review_resolution"
          }),
          allowBlocked: true
        });
        return replayed
          .filter((event) => blockedEventIds.has(String(event.eventId)))
          .map((event) => ({
            eventId: event.eventId,
            status: event.status,
            effectiveJobId: event.effectiveJobId || "",
            reason: event.reviewReason || "",
            result: event.result || {}
          }));
      }
    });
    let drained = [];
    let drainError = null;
    try {
      drained = await drainDriverOfflineDeviceStream({
        driverLogin: result.driverLogin,
        planDate: result.planDate,
        deviceId: result.deviceId,
        emissionSource: "offline_review_resolution"
      });
    } catch (error) {
      drainError = {
        code: String(error?.code || "OFFLINE_QUEUE_RETRY_FAILED").slice(0, 160),
        error: String(error?.message || error || "The remaining device event queue could not be retried.").slice(0, 2000)
      };
    }
    emitAppEvent("driver.offline.review.resolved", {
      eventId: req.params.eventId,
      source: "offline_review_resolution",
      action: req.body?.action,
      resolvedBy: req.operator?.username || req.operator?.id || ""
    });
    res.json({
      ...result,
      drained,
      ...(drainError ? { drainError } : {})
    });
  } catch (error) {
    next(error);
  }
});

async function scmVendorManagementPayload() {
  const [vendors, yards] = await Promise.all([
    listDispatchLocalVendors(),
    listDispatchVendorYards()
  ]);
  return { vendors, yards, weekDays: [...DISPATCH_VENDOR_WEEK_DAYS] };
}

app.get("/api/scm/local-vendors", async (req, res, next) => {
  try {
    res.json(await scmVendorManagementPayload());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/local-vendors", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Local vendor name is required." });
    const created = await createDispatchLocalVendor({ name, updatedBy: operatorId(req) });
    await writeAudit({
      actorOperatorId: operatorId(req),
      source: "smart_scm",
      action: "scm.local_vendor.create",
      details: { localVendor: created }
    });
    emitAppEvent("dispatch.vendor_yard.updated", { source: "scm-local-vendor-create", localVendorId: created?.id });
    res.json({ created, ...(await scmVendorManagementPayload()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/local-vendors/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Local vendor name is required." });
    const updated = await updateDispatchLocalVendor(req.params.id, {
      name,
      active: req.body?.active,
      updatedBy: operatorId(req)
    });
    if (!updated) return res.status(404).json({ error: "Local vendor not found." });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: operatorId(req),
      source: "smart_scm",
      action: "scm.local_vendor.update",
      details: { localVendor: updated, enriched }
    });
    emitAppEvent("dispatch.vendor_yard.updated", { source: "scm-local-vendor-update", localVendorId: req.params.id });
    emitAppEvent("dispatch.orders.updated", { source: "scm-local-vendor-update", enriched });
    res.json({ updated, enriched, ...(await scmVendorManagementPayload()) });
  } catch (error) {
    next(error);
  }
});

async function saveScmVendorYard(req, res, next) {
  try {
    const saved = await saveDispatchVendorYardSchedule({
      localVendorId: req.params.id,
      yardRowId: req.params.yardRowId || null,
      yard: req.body?.yard,
      aliases: req.body?.aliases,
      address: req.body?.address,
      days: req.body?.days,
      updatedBy: operatorId(req)
    });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: operatorId(req),
      source: "smart_scm",
      action: req.params.yardRowId ? "scm.local_vendor_yard.update" : "scm.local_vendor_yard.create",
      details: {
        localVendorId: req.params.id,
        yardRowId: req.params.yardRowId || null,
        yard: saved.yard,
        previousYard: saved.previousYard,
        activeDays: saved.rows.filter((row) => row.active).map((row) => row.dayLabel),
        enriched
      }
    });
    emitAppEvent("dispatch.vendor_yard.updated", {
      source: "scm-local-vendor-yard",
      localVendorId: req.params.id,
      yard: saved.yard,
      previousYard: saved.previousYard
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-local-vendor-yard", enriched });
    res.json({ saved, enriched, ...(await scmVendorManagementPayload()) });
  } catch (error) {
    next(error);
  }
}

app.post("/api/scm/local-vendors/:id/yards", requireSmartScmWriteAccess, saveScmVendorYard);
app.put("/api/scm/local-vendors/:id/yards/:yardRowId", requireSmartScmWriteAccess, saveScmVendorYard);

app.get("/api/dispatch/config", (req, res) => {
  res.json({
    googleMapsApiKey: config.googleMapsApiKey,
    driverOrientedPlanning: Boolean(config.dispatch?.driverOrientedPlanning)
  });
});

app.get("/api/dispatch/forecast", async (req, res, next) => {
  try {
    const planId = String(req.query.planId || "").trim();
    if (!/^\d+$/.test(planId)) return res.status(400).json({ error: "A valid dispatch plan ID is required." });
    const plan = await getDispatchPlan(planId);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found." });
    const [driverJobStatuses, setup] = await Promise.all([
      listDriverJobStatuses({ planId: plan.id }),
      readDispatchSetup()
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json(buildDispatchForecast(plan, driverJobStatuses, { driverProfiles: setup.drivers }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/monitor", async (req, res, next) => {
  try {
    const planDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : localDateDaysAgo(0);
    const setup = await readDispatchSetup();
    const plan = await getCurrentDispatchPlan({ planDate });
    const driverJobStatuses = plan?.id ? await listDriverJobStatuses({ planId: plan.id }) : [];
    const forecast = plan
      ? buildDispatchForecast(plan, driverJobStatuses, { driverProfiles: setup.drivers })
      : null;
    const truckSwitchAttention = plan?.id ? await listDriverTruckSwitchAttention({ planId: plan.id }) : [];
    const switchAttentionByPlate = new Map();
    for (const item of truckSwitchAttention) {
      const plate = normalizedPlate(item.to_truck_plate);
      if (plate && !switchAttentionByPlate.has(plate)) switchAttentionByPlate.set(plate, item);
    }
    const currentDriverResult = await query(
      `SELECT DISTINCT ON (upper(COALESCE(NULLIF(current_truck_plate, ''), truck_plate)))
              driver_login,
              COALESCE(NULLIF(current_truck_plate, ''), truck_plate) AS truck_plate,
              current_load_id,
              updated_at
         FROM driver_day_records
        WHERE plan_date = $1::date
          AND on_duty_at IS NOT NULL
          AND off_duty_at IS NULL
          AND COALESCE(NULLIF(current_truck_plate, ''), truck_plate, '') <> ''
        ORDER BY upper(COALESCE(NULLIF(current_truck_plate, ''), truck_plate)), updated_at DESC`,
      [planDate]
    );
    const currentDriverByPlate = new Map(currentDriverResult.rows.map((item) => [normalizedPlate(item.truck_plate), item]));
    const driverNameByLogin = new Map((setup.drivers || []).map((driver) => [String(driver.login || "").trim().toLowerCase(), driver.name || driver.login || ""]));
    const currentTruckMap = new Map();
    for (const truck of setup.trucks || []) {
      const plate = String(truck.plate || "").trim();
      if (plate) currentTruckMap.set(normalizedPlate(plate), { ...truck, plate });
    }
    const plates = [...currentTruckMap.values()].map((truck) => truck.plate).filter(Boolean);
    let locations = [];
    let samsaraError = "";
    try {
      locations = await listSamsaraVehicleLocations({ plates });
    } catch (error) {
      samsaraError = error.message;
    }
    const locationByPlate = new Map(locations.map((location) => [normalizedPlate(location.plate), location]));
    let trucks = [...currentTruckMap.values()].map((truck) => {
      const location = locationByPlate.get(normalizedPlate(truck.plate)) || {};
      const activeLoad = monitorLoadForTruck(plan, truck, driverJobStatuses);
      const currentDriver = currentDriverByPlate.get(normalizedPlate(truck.plate)) || null;
      const plannedAssignment = (plan?.trucks || []).flatMap((parentTruck) => (parentTruck.loads || []).map((load) => ({
        parentTruck,
        load,
        assignment: dispatchLoadAssignment(parentTruck, load)
      }))).find((entry) => normalizedPlate(entry.assignment.truckPlate) === normalizedPlate(truck.plate));
      return {
        plate: truck.plate || "",
        vehicleId: location.vehicleId || "",
        vehicleName: location.vehicleName || "",
        latitude: location.latitude,
        longitude: location.longitude,
        headingDegrees: Number.isFinite(Number(location.headingDegrees)) ? Number(location.headingDegrees) : null,
        speedMilesPerHour: location.speedMilesPerHour || 0,
        formattedLocation: location.formattedLocation || "",
        locationTime: location.time || "",
        driver: activeLoad?.driver || driverNameByLogin.get(String(currentDriver?.driver_login || "").toLowerCase()) || currentDriver?.driver_login || "",
        driverLogin: activeLoad?.driverLogin || currentDriver?.driver_login || "",
        base: plannedAssignment?.assignment?.switchYard || truck.base || "",
        parkingSpot: activeLoad?.parkingSpot || plannedAssignment?.assignment?.parkingSpot || "",
        activeLoad,
        truckSwitchAttention: switchAttentionByPlate.get(normalizedPlate(truck.plate)) || null
      };
    });
    await recordTruckLocationHistory(trucks).catch(() => null);
    const trails = await truckLocationTrails(plates);
    trucks = trucks.map((truck) => ({
      ...truck,
      estimatedKmh: Number.isFinite(Number(truck.speedMilesPerHour)) ? Number(truck.speedMilesPerHour) * 1.609344 : null
    }));
    const ownYards = uniqueYardLocations((setup.ownYards || []).map((yard) => ({ ...yard, type: "own", name: yard.name || yard.code })));
    const vendorYards = uniqueYardLocations((await listDispatchVendorYards()).map((yard) => ({ ...yard, type: "vendor" })));
    res.json({
      planDate,
      refreshSeconds: 10,
      plan: plan ? { id: plan.id, status: plan.status, planDate: plan.planDate } : null,
      plannedOrders: monitorPlannedOrders(plan, driverJobStatuses, forecast),
      forecastGeneratedAt: forecast?.generatedAt || null,
      trucks,
      trails,
      yards: [...ownYards, ...vendorYards],
      samsaraError,
      sources: {
        samsaraEndpoint: "/fleet/vehicles/locations",
        refreshRecommendation: "10 seconds"
      }
    });
  } catch (error) {
    next(error);
  }
});

function salesScheduleRowMatchesYards(row, yardCodes = []) {
  const route = `${row?.pickupPoint || ""} ${row?.dropoffPoint || ""}`;
  return yardCodes.some((yardCode) => new RegExp(`(^|[^0-9])${yardCode}([^0-9]|$)`).test(route));
}

function scmScheduleAudienceForOperator(operator) {
  return canViewRestrictedScmOrders(operator) ? "scm" : "operations";
}

async function listScmScheduleForOperator(filters = {}, operator = null) {
  const includeRestricted = canViewRestrictedScmOrders(operator);
  const rows = await listScmSchedule({
    ...filters,
    audience: scmScheduleAudienceForOperator(operator)
  });
  const reconciled = await enrichScmScheduleWithReconciliation(rows, {
    includeDetails: false,
    view: filters.view || "",
    reviewOnly: false
  });
  return filterRestrictedScmOrders(reconciled, { includeRestricted });
}

app.get("/api/sales/in-outbound-records", requirePrivateSalesRecordAccess, async (req, res, next) => {
  try {
    res.json(await listYardMovements({
      from: req.query.from,
      to: req.query.to,
      yard: req.query.yard,
      search: req.query.search,
      itemSearch: req.query.itemSearch,
      direction: req.query.direction,
      orderType: req.query.orderType,
      allowedSalesStoreLocationIds: operatorSalesYardLocationIds(req.operator)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/in-outbound-records/detail", requirePrivateSalesRecordAccess, async (req, res, next) => {
  try {
    const detail = await getYardMovementDetail({
      direction: req.query.direction,
      orderType: req.query.orderType,
      orderId: req.query.orderId,
      from: req.query.from,
      to: req.query.to,
      allowedSalesStoreLocationIds: operatorSalesYardLocationIds(req.operator)
    });
    if (!detail) return res.status(404).json({ error: "In/Outbound record not found." });
    return res.json(detail);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/sales/in-outbound-records/export.csv", requirePrivateSalesRecordAccess, async (req, res, next) => {
  try {
    await sendLoadedOrdersCsv(req, res, {
      allowedSalesStoreLocationIds: operatorSalesYardLocationIds(req.operator)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/schedule-presets", async (req, res, next) => {
  try {
    const presets = await listScmViewPresets();
    const allowed = new Set(canViewRestrictedScmOrders(req.operator)
      ? ["yard manager", "completed"]
      : ["yard manager"]);
    res.json(presets.filter((preset) => allowed.has(String(preset.name || "").trim().toLowerCase())));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/schedule-formatting", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const formatting = await getScmScheduleFormatting();
    res.json({ version: formatting.version, rules: formatting.rules });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/schedule", async (req, res, next) => {
  try {
    const requestedView = String(req.query.view || "yard manager").trim().toLowerCase();
    const includeRestricted = canViewRestrictedScmOrders(req.operator);
    const view = includeRestricted && requestedView === "completed" ? "completed" : "yard manager";
    const rows = await listScmSchedule({
      search: req.query.search || "",
      status: req.query.status || "",
      method: req.query.method || "",
      kind: req.query.kind || "",
      yard: req.query.dropoffPoint || req.query.yard || "",
      brand: req.query.brand || "",
      from: req.query.from || "",
      to: req.query.to || "",
      view,
      audience: includeRestricted ? "scm" : "operations"
    });
    const yardCodes = operatorSalesYardCodes(req.operator);
    const scoped = rows.filter((row) => salesScheduleRowMatchesYards(row, yardCodes));
    const canSeeReconciliationDetails = operatorHasAnyRole(req.operator, ["admin"]);
    const reconciliationPreference = canSeeReconciliationDetails
      ? await getScmReconciliationPreference(req.operator?.id)
      : { showDetails: false };
    const reconciled = await enrichScmScheduleWithReconciliation(scoped, {
      includeDetails: canSeeReconciliationDetails && reconciliationPreference.showDetails,
      view,
      reviewOnly: String(req.query.reconciliationStatus || "").toLowerCase() === "review"
    });
    const visibleRows = includeRestricted
      ? reconciled
      : filterRestrictedScmOrders(reconciled, { includeRestricted: false });
    res.json(visibleRows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/schedule-preferences", async (req, res, next) => {
  try {
    if (!req.operator?.id) {
      return res.json({ surface: "sales", kind: "", method: "", status: [], persisted: false });
    }
    res.json(await getScmSchedulePreference(req.operator.id, "sales"));
  } catch (error) {
    next(error);
  }
});

app.put("/api/sales/schedule-preferences", async (req, res, next) => {
  try {
    if (!req.operator?.id || req.publicSalesAccess || req.operator?.publicSales) {
      return res.status(403).json({ error: "A signed-in Sales or Admin account is required to save schedule filters." });
    }
    res.json(await updateScmSchedulePreference(req.operator.id, "sales", req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/printers", async (req, res, next) => {
  try {
    const allowed = new Set(salesPrintDestinationLocationIds());
    res.json((await listYardPrinters()).filter((printer) => allowed.has(Number(printer.locationId))));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/print-jobs", async (req, res, next) => {
  try {
    const allowed = salesPrintDestinationLocationIds();
    const requestedLocation = Number(req.query.locationId || 0);
    const locations = requestedLocation
      ? (allowed.includes(requestedLocation) ? [requestedLocation] : [])
      : allowed;
    const pages = await Promise.all(locations.map((locationId) => listSmartScmPrintJobs({
      locationId,
      status: req.query.status || "",
      limit: Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    })));
    res.json(pages.flat()
      .filter((job) => job.documentType === "sales_order_picking_ticket")
      .sort((left, right) => Number(right.id) - Number(left.id))
      .slice(0, Math.min(200, Math.max(1, Number(req.query.limit) || 100))));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/sales-orders", async (req, res, next) => {
  try {
    res.json(await listSalesOrderPrintCandidates({
      search: req.query.search || "",
      orderingLocationIds: operatorSalesYardLocationIds(req.operator),
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/sales-orders/:id/print-history", async (req, res, next) => {
  try {
    const candidate = await getSalesOrderPrintCandidate({
      orderId: req.params.id,
      allowedOrderingLocationIds: operatorSalesYardLocationIds(req.operator)
    });
    res.json({
      order: candidate,
      history: await listSalesOrderPrintHistory(candidate.orderId)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/sales-orders/:id/print-history/:jobId/snapshot", async (req, res, next) => {
  try {
    const candidate = await getSalesOrderPrintCandidate({
      orderId: req.params.id,
      allowedOrderingLocationIds: operatorSalesYardLocationIds(req.operator)
    });
    const snapshot = await getSalesOrderPrintSnapshot({
      orderId: candidate.orderId,
      jobId: req.params.jobId
    });
    const filename = String(snapshot.documentName || `${candidate.orderRef}-picking-ticket.pdf`)
      .replace(/[^a-zA-Z0-9_.-]+/g, "-");
    res.type("application/pdf");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.sendFile(snapshot.documentPath, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/sales-orders/:id/picking-ticket-preview", async (req, res, next) => {
  try {
    const { candidate, lineYard, lineLocationId, printer } = await salesOrderPrintContext(
      req,
      req.query.lineLocationId ?? req.query.printerLocationId
    );
    const document = await fetchPickingTicketFromNetSuite(candidate.orderId, {
      locationId: lineLocationId,
      filenamePrefix: candidate.orderRef || "SO"
    });
    if (candidate.lineYards.length > 1 && !document.locationApplied) {
      throw Object.assign(new Error("NetSuite did not confirm the selected line-yard filter. Deploy the updated picking-ticket RESTlet before previewing this multi-yard order."), { status: 409 });
    }
    const filename = String(document.filename || `${candidate.orderRef || "SO"}-picking-ticket.pdf`)
      .replace(/[^a-zA-Z0-9_.-]+/g, "-");
    res.type(document.contentType || "application/pdf");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("X-MBBS-Print-Yard", printer.yardCode || "");
    res.setHeader("X-MBBS-Line-Yard", lineYard.yardCode || "");
    res.setHeader("X-MBBS-Print-Preview-Token", storeSalesPrintPreview({
      orderId: candidate.orderId,
      lineLocationId,
      document: { ...document, filename }
    }));
    res.send(document.buffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sales/sales-orders/:id/print", async (req, res, next) => {
  try {
    const requestedCompanyName = optionalSalesPrintCompanyName(req.body?.companyName);
    const requestedIpAddress = salesPrintRequestIp(req);
    const previewToken = String(req.body?.previewToken || "").trim();
    const { candidate, lineYard, lineLocationId, printer, printerLocationId } = await salesOrderPrintContext(
      req,
      req.body?.lineLocationId ?? req.body?.printerLocationId ?? req.body?.locationId
    );
    if (!printer.salesOrderReady) {
      throw Object.assign(new Error(`${printer.yardCode} requires exactly one printer assigned to SO printing, an enabled yard queue, and an agent token.`), { status: 409 });
    }
    const document = previewToken
      ? getSalesPrintPreview(previewToken, { orderId: candidate.orderId, lineLocationId })
      : await fetchPickingTicketFromNetSuite(candidate.orderId, {
          locationId: lineLocationId,
          filenamePrefix: candidate.orderRef || "SO"
        });
    if (candidate.lineYards.length > 1 && !document.locationApplied) {
      throw Object.assign(new Error("NetSuite did not confirm the selected line-yard filter. Printing was blocked to prevent the wrong yard ticket."), { status: 409 });
    }
    const printJob = await queueSmartScmPrintJob({
      locationId: printerLocationId,
      documentType: "sales_order_picking_ticket",
      documentName: document.filename,
      documentBuffer: document.buffer,
      jobKey: `sales:${candidate.orderId}:${lineLocationId}:${Date.now()}:${crypto.randomUUID()}`,
      sourceOrderId: candidate.orderId,
      sourceOrderRef: candidate.orderRef,
      lineLocationId,
      requestedCompanyName,
      requestedIpAddress
    }, req.operator?.id || null);
    if (previewToken) salesPrintPreviews.delete(previewToken);
    await writeAudit({
      actorType: req.operator?.id ? "operator" : "anonymous",
      actorOperatorId: req.operator?.id || null,
      source: "sales",
      action: "sales.sales_order_picking_ticket.queued",
      orderId: candidate.orderId,
      details: {
        orderRef: candidate.orderRef,
        orderingLocationId: candidate.orderingLocationId,
        orderingYardCode: candidate.orderingYardCode,
        lineLocationId,
        lineYardCode: lineYard.yardCode,
        printerLocationId,
        printerYardCode: printer.yardCode,
        requestedCompanyName,
        requestedIpAddress,
        printJobId: printJob.id
      }
    });
    res.json({ order: candidate, lineYard, printer, printJob });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/dvir-records", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : localDateDaysAgo(0);
    const result = await pool.query(
      `SELECT id, driver_login, plan_id, plan_date::text AS plan_date,
              truck_id, truck_plate, samsara_username,
              COALESCE(pre_dvir_photo_data_urls, '[]'::jsonb) AS pre_photos,
              COALESCE(post_dvir_photo_data_urls, '[]'::jsonb) AS post_photos,
              pre_dvir_completed_at, post_dvir_completed_at,
              on_duty_at, off_duty_at,
              COALESCE(samsara_on_duty_response, '{}'::jsonb) AS samsara_on_response,
              COALESCE(samsara_off_duty_response, '{}'::jsonb) AS samsara_off_response,
              updated_at
         FROM driver_day_records
        WHERE plan_date = $1::date
        ORDER BY COALESCE(post_dvir_completed_at, pre_dvir_completed_at, updated_at) DESC,
                 driver_login ASC`,
      [date]
    );
    const records = result.rows.map((row) => {
      const prePhotos = Array.isArray(row.pre_photos) ? row.pre_photos.filter(Boolean) : [];
      const postPhotos = Array.isArray(row.post_photos) ? row.post_photos.filter(Boolean) : [];
      return {
        id: row.id,
        driverLogin: row.driver_login || "",
        planId: row.plan_id || null,
        planDate: row.plan_date || date,
        truckId: row.truck_id || "",
        truckPlate: row.truck_plate || "",
        samsaraUsername: row.samsara_username || "",
        prePhotos,
        postPhotos,
        prePhotoCount: prePhotos.length,
        postPhotoCount: postPhotos.length,
        preCompletedAt: row.pre_dvir_completed_at || "",
        postCompletedAt: row.post_dvir_completed_at || "",
        onDutyAt: row.on_duty_at || "",
        offDutyAt: row.off_duty_at || "",
        samsaraPreDvirId: row.samsara_on_response?.dvirId || row.samsara_on_response?.dvir?.id || row.samsara_on_response?.verifiedDvir?.id || "",
        samsaraPostDvirId: row.samsara_off_response?.dvirId || row.samsara_off_response?.dvir?.id || row.samsara_off_response?.verifiedDvir?.id || "",
        preError: row.samsara_on_response?.error || row.samsara_on_response?.clockError || "",
        postError: row.samsara_off_response?.error || row.samsara_off_response?.clockError || "",
        updatedAt: row.updated_at || ""
      };
    });
    res.json({ date, records });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/statistics", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json(await getDispatchStatistics({
      from: req.query.from || "",
      to: req.query.to || "",
      driver: req.query.driver || ""
    }));
  } catch (error) {
    next(error);
  }
});

function dispatchPrivateNoStore(res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

app.get("/api/dispatch/v2/bootstrap", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    dispatchPrivateNoStore(res);
    res.json(await getDispatchV2Bootstrap({
      planId: req.query.planId || "",
      date: req.query.date || req.query.planDate || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/v2/order-feed/:id", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    dispatchPrivateNoStore(res);
    const order = (await targetedDispatchMutationOrders([req.params.id]))[0] || null;
    if (!order) return res.status(404).json({ error: "Dispatch order not found", code: "DISPATCH_ORDER_NOT_FOUND" });
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

function dispatchV2CandidateConflict(code, message, conflicts = []) {
  return Object.assign(new Error(message), { code, status: 409, conflicts });
}

async function prepareDispatchV2ReplaceCommand(previousPlan = {}, command = {}) {
  const payload = command.payload || {};
  const requestedPlanDate = String(payload.planDate || previousPlan.planDate || "").slice(0, 10);
  const existingPlanDate = String(previousPlan.planDate || "").slice(0, 10);
  if (requestedPlanDate && existingPlanDate && requestedPlanDate !== existingPlanDate) {
    throw Object.assign(new Error("The replacement board belongs to a different plan date."), {
      code: "DISPATCH_PLAN_DATE_MISMATCH",
      status: 409,
      expectedPlanDate: existingPlanDate,
      payloadPlanDate: requestedPlanDate
    });
  }
  if (!Array.isArray(payload.orders) || !Array.isArray(payload.trucks)) {
    throw Object.assign(new Error("A compact order list and truck board are required."), {
      code: "DISPATCH_COMMAND_INVALID",
      status: 400
    });
  }

  let cleanOrders = payload.orders;
  let cleanTrucks = payload.trucks;
  if (config.dispatch?.driverOrientedPlanning) {
    cleanTrucks = normalizeDispatchPlanLoadAssignments({ ...previousPlan, trucks: cleanTrucks }).trucks;
  }
  const canonicalCandidate = await canonicalizeDispatchCustomOrdersInPlan({
    ...previousPlan,
    planDate: existingPlanDate,
    orders: cleanOrders,
    trucks: cleanTrucks
  }, { previousPlan });
  cleanOrders = sanitizeDispatchPlanOrders(canonicalCandidate.orders || []);
  cleanTrucks = canonicalCandidate.trucks || [];
  const scheduleCandidate = await overlayDispatchLockedLoadSchedule(previousPlan, {
    ...previousPlan,
    planDate: existingPlanDate,
    orders: cleanOrders,
    trucks: cleanTrucks
  });
  cleanTrucks = scheduleCandidate.trucks || [];
  const candidate = {
    ...previousPlan,
    planDate: existingPlanDate,
    orders: cleanOrders,
    trucks: cleanTrucks
  };

  const changedScmRefs = changedDispatchScmRefs(previousPlan, candidate);
  await assertScmReconciliationOrderEditable({ orderRefs: changedScmRefs });
  await assertNoRestrictedScmDispatchOrders(
    changedPlacedDispatchScmAssignmentRefs(previousPlan, candidate),
    "save this plan"
  );
  const duplicateDrivers = config.dispatch?.driverOrientedPlanning ? [] : dispatchDuplicateDriverAssignments(cleanTrucks);
  if (duplicateDrivers.length) {
    throw dispatchV2CandidateConflict(
      "DISPATCH_DRIVER_DUPLICATE",
      "One driver can only be assigned to one truck.",
      duplicateDrivers
    );
  }
  const dependencyStructureChanges = await assertNoConsolidationStructureConflict(previousPlan, candidate);
  const assignmentConflicts = await dispatchLoadAssignmentConflicts(previousPlan, candidate);
  if (assignmentConflicts.length) {
    const first = assignmentConflicts[0] || {};
    throw dispatchV2CandidateConflict(
      first.code || "DISPATCH_DRIVER_TIME_CONFLICT",
      first.message || "Driver or truck assignment is invalid.",
      assignmentConflicts
    );
  }
  const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan, candidate);
  if (dateConflicts.length) {
    const preview = dateConflicts.slice(0, 5).map((item) => `${item.orderRef} on ${item.planDate}`).join(", ");
    throw dispatchV2CandidateConflict(
      "DISPATCH_ORDER_ALREADY_PLANNED",
      `Some orders are already planned on another date${preview ? `: ${preview}` : "."}`,
      dateConflicts
    );
  }
  const coSequenceConflicts = await findChangedDispatchCoSequenceConflicts(previousPlan, candidate);
  if (coSequenceConflicts.length) {
    throw dispatchV2CandidateConflict(
      "DISPATCH_CO_SEQUENCE_INVALID",
      coSequenceConflicts.slice(0, 3).map((item) => item.reason).join(" ") || "CO must be planned before the original order pickup.",
      coSequenceConflicts
    );
  }
  const dependencyConflicts = await validateDispatchPlanDependencies(candidate);
  if (dependencyConflicts.length) {
    throw dispatchV2CandidateConflict(
      "DISPATCH_ORDER_DEPENDENCY_CONFLICT",
      String(dependencyConflicts[0] || "Order dependency timing is invalid."),
      dependencyConflicts
    );
  }

  const explicitOperatorAlertRefs = [...new Set((payload.operatorAlertRefs || [])
    .map((ref) => String(ref || "").trim())
    .filter(Boolean))];
  const beforePlanned = dispatchPlannedOrderRefs(previousPlan);
  const afterPlanned = dispatchPlannedOrderRefs(candidate);
  const placementChanges = [...new Set([...beforePlanned, ...afterPlanned])]
    .filter((ref) => beforePlanned.has(ref) !== afterPlanned.has(ref));
  const affectedOrderRefs = [...new Set([
    ...placementChanges,
    ...changedScmRefs,
    ...changedDispatchOperatorRefs(previousPlan, candidate),
    ...changedDispatchOrderStructureRefs(previousPlan, candidate),
    ...explicitOperatorAlertRefs,
    ...(payload.affectedOrderRefs || [])
  ].map((ref) => String(ref || "").trim()).filter(Boolean))];
  return {
    ...command,
    payload: {
      ...payload,
      planDate: existingPlanDate,
      orders: cleanOrders,
      trucks: cleanTrucks,
      summary: await dispatchPlanSummaryWithSetup(payload.summary || {}),
      affectedOrderRefs,
      operatorAlertRefs: explicitOperatorAlertRefs,
      safeUngroupTargets: dependencyStructureChanges.safeUngroupTargets || []
    }
  };
}

app.post("/api/dispatch/v2/plans/:id/commands", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    dispatchPrivateNoStore(res);
    const previousPlan = await getDispatchPlan(req.params.id);
    if (!previousPlan) return res.status(404).json({ error: "Dispatch plan not found", code: "DISPATCH_PLAN_NOT_FOUND" });
    await requireDispatchV2PlanEditLease(req, previousPlan.planDate);
    const submittedCommand = {
      ...(req.body || {}),
      sourceRequestHash: crypto.createHash("sha256").update(JSON.stringify(stableJsonValue({
        commandId: String(req.body?.commandId || ""),
        baseRevision: Number(req.body?.baseRevision),
        baseDigest: String(req.body?.baseDigest || ""),
        commandType: String(req.body?.commandType || req.body?.type || ""),
        payload: req.body?.payload || {}
      }))).digest("hex")
    };
    const stored = await getDispatchV2CommandReplay({ command: submittedCommand });
    if (stored) {
      res.setHeader("X-Dispatch-Idempotent-Replay", "true");
      return res.json(stored.payload);
    }
    const command = String(submittedCommand.commandType || submittedCommand.type || "") === "replace_plan"
      ? await prepareDispatchV2ReplaceCommand(previousPlan, submittedCommand)
      : submittedCommand;
    const result = await applyDispatchV2Command({
      planId: req.params.id,
      command,
      actorId: req.operator?.id || null
    });
    if (result.replay) res.setHeader("X-Dispatch-Idempotent-Replay", "true");
    if (!result.replay) {
      emitAppEvent("dispatch.plan.saved", {
        planId: result.payload.plan.id,
        planDate: result.payload.plan.planDate,
        revision: result.payload.plan.revision,
        savedAt: result.payload.plan.savedAt,
        sourceSessionId: command.sessionId || "",
        commandType: command.commandType || command.type || "",
        affectedOrderRefs: dispatchV2PatchOrderRefs(result.payload.patch || {})
      });
      void writeDispatchAudit({
        action: `dispatch_plan_${String(result.payload.patch?.actionName || command.commandType || command.type || "command")}`,
        entityType: "plan",
        entityId: String(result.payload.plan.id),
        planId: result.payload.plan.id,
        planDate: result.payload.plan.planDate,
        operatorId: req.operator?.id,
        operatorName: req.operator?.display_name || req.operator?.username,
        sessionId: command.sessionId || "",
        after: result.payload.patch,
        details: {
          commandId: command.commandId || "",
          revision: result.payload.plan.revision,
          incremental: true
        }
      }).catch(() => null);
    }
    res.json(result.payload);
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/v2/plans/:id/checkpoints", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    dispatchPrivateNoStore(res);
    res.json({ checkpoints: await listDispatchV2Checkpoints({ planId: req.params.id, date: req.query.date || "" }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/v2/plans/:id/checkpoints/:checkpointId", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    dispatchPrivateNoStore(res);
    const checkpoint = await getDispatchV2Checkpoint({
      planId: req.params.id,
      checkpointId: req.params.checkpointId
    });
    if (!checkpoint) return res.status(404).json({ error: "Dispatch checkpoint not found" });
    res.json({ checkpoint });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/v2/plans/:id/changes", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    dispatchPrivateNoStore(res);
    const sinceRevision = Math.max(0, Number(req.query.sinceRevision) || 0);
    const result = await query(
      `SELECT command_id, command_type, base_revision, applied_revision, result, created_at
         FROM dispatch_plan_commands
        WHERE plan_id = $1
          AND applied_revision > $2
        ORDER BY applied_revision
        LIMIT 200`,
      [req.params.id, sinceRevision]
    );
    res.json({
      changes: result.rows.map((row) => ({
        commandId: row.command_id,
        commandType: row.command_type,
        baseRevision: Number(row.base_revision),
        revision: Number(row.applied_revision),
        patch: row.result?.patch || {},
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans", async (req, res, next) => {
  try {
    res.json(await listDispatchPlans({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plan-edit-lease", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json({ lease: await getDispatchPlanEditLease(req.query.planDate || req.query.date || "") });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plan-edit-lease/acquire", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const acquired = await acquireDispatchPlanEditLease(dispatchEditLeaseInput(req));
    await writeDispatchAudit({
      action: acquired.replacedExpired ? "dispatch_plan_edit_lease_expired_takeover" : acquired.renewed ? "dispatch_plan_edit_lease_renewed" : "dispatch_plan_edit_lease_acquired",
      entityType: "plan",
      entityId: acquired.lease.planDate,
      planDate: acquired.lease.planDate,
      operatorId: req.operator.id,
      operatorName: req.operator.display_name || req.operator.username,
      sessionId: acquired.lease.sessionId,
      details: { expiresAt: acquired.lease.expiresAt }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.edit_lease_changed", {
      planDate: acquired.lease.planDate,
      lease: acquired.lease,
      sourceSessionId: acquired.lease.sessionId
    });
    res.json({ lease: acquired.lease, editLeaseToken: acquired.token });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.post("/api/dispatch/plan-edit-lease/heartbeat", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json({ lease: await heartbeatDispatchPlanEditLease(dispatchEditLeaseInput(req)) });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.post("/api/dispatch/plan-edit-lease/release", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const released = await releaseDispatchPlanEditLease(dispatchEditLeaseInput(req));
    if (released) {
      await writeDispatchAudit({
        action: "dispatch_plan_edit_lease_released",
        entityType: "plan",
        entityId: released.planDate,
        planDate: released.planDate,
        operatorId: req.operator.id,
        operatorName: req.operator.display_name || req.operator.username,
        sessionId: released.sessionId
      }).catch(() => null);
      emitAppEvent("dispatch.plan.edit_lease_changed", {
        planDate: released.planDate,
        lease: null,
        sourceSessionId: released.sessionId
      });
    }
    res.json({ released: Boolean(released) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req, req.body?.planDate);
    const plan = await createDispatchPlan({
      planDate: req.body?.planDate,
      note: req.body?.note || ""
    });
    await writeDispatchAudit({
      action: "dispatch_plan_created",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { planDate: plan.planDate }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.created", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/current", async (req, res, next) => {
  try {
    const plan = await getCurrentDispatchPlan({ planDate: req.query.date });
    res.json(plan
      ? { ...plan, exists: true }
      : { exists: false, savedAt: "", orders: [], trucks: [], planDate: req.query.date || new Date().toISOString().slice(0, 10) });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/plan-snapshots", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json(await listDispatchPlanSnapshots({ planDate: req.query.date }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plan-snapshots/:snapshotId", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const snapshot = await getDispatchPlanSnapshot(req.params.snapshotId);
    if (!snapshot) return res.status(404).json({ error: "Dispatch snapshot not found" });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plan-snapshots/:snapshotId/restore", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    if (String(req.params.snapshotId || "").startsWith("current-")) {
      return res.status(409).json({ error: "The current active version is already active." });
    }
    const beforePlan = await getDispatchPlanSnapshot(req.params.snapshotId);
    if (!beforePlan) return res.status(404).json({ error: "Dispatch snapshot not found" });
    await requireDispatchPlanEditLease(req, beforePlan.planDate);
    const currentPlanBeforeRestore = await getDispatchPlan(beforePlan.planId);
    let restoreCandidate = normalizeDispatchPlanLoadAssignments({
      ...currentPlanBeforeRestore,
      planDate: beforePlan.planDate,
      orders: beforePlan.orders || [],
      trucks: beforePlan.rawTrucks || []
    });
    restoreCandidate = await canonicalizeDispatchCustomOrdersInPlan(restoreCandidate, {
      previousPlan: currentPlanBeforeRestore
    });
    const changedScmRefs = changedDispatchScmRefs(currentPlanBeforeRestore, restoreCandidate);
    await assertScmReconciliationOrderEditable({ orderRefs: changedScmRefs });
    await assertNoRestrictedScmDispatchOrders(
      changedPlacedDispatchScmAssignmentRefs(currentPlanBeforeRestore, restoreCandidate),
      "restore this snapshot"
    );
    const dependencyStructureChanges = await assertNoConsolidationStructureConflict(
      currentPlanBeforeRestore,
      restoreCandidate
    );
    const assignmentConflicts = await dispatchLoadAssignmentConflicts(currentPlanBeforeRestore, restoreCandidate, {
      requireAssignments: String(currentPlanBeforeRestore?.status || "") === "confirmed"
    });
    if (assignmentConflicts.length) return sendDispatchLoadAssignmentConflictResponse(res, assignmentConflicts);
    const dependencyConflicts = await validateDispatchPlanDependencies(restoreCandidate);
    if (dependencyConflicts.length) return sendDispatchDependencyConflictResponse(res, dependencyConflicts);
    const restored = await restoreDispatchPlanSnapshot(req.params.snapshotId, {
      sessionId: req.body?.audit?.sessionId || ""
    });
    const plan = restored.plan;
    await syncOrderDependenciesFromDispatchPlan(plan, {
      allowEstablishedUngroupTargets: dependencyStructureChanges.safeUngroupTargets
    });
    const coAssignments = await applyDispatchPlanCoAssignments(plan);
    const scmSchedule = await syncScmScheduleFromDispatchPlan(plan, { updatedBy: req.body?.audit?.sessionId || "dispatch-plan-save" }).catch(() => null);
    const changedOperatorRefs = [...dispatchOperatorAssignmentMap(plan).keys()];
    const operatorFlags = plan.status === "confirmed"
      ? await applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs: changedOperatorRefs })
      : null;
    await writeDispatchAudit({
      action: "dispatch_plan_snapshot_restored",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      before: {
        snapshotId: req.params.snapshotId,
        revision: restored.previousRevision
      },
      after: plan,
      details: {
        restoredSnapshotId: req.params.snapshotId,
        previousRevision: restored.previousRevision,
        restoredRevision: plan.revision,
        restoredOrderCount: plan.orders.length,
        restoredTruckCount: plan.trucks.length,
        restoredLoadCount: (plan.trucks || []).reduce((sum, truck) => sum + (truck.loads || []).length, 0),
        restoredStopCount: (plan.trucks || []).reduce((sum, truck) => sum + (truck.loads || []).reduce((loadSum, load) => loadSum + (load.stops || []).length, 0), 0),
        sourceArchivedAt: beforePlan.archivedAt,
        coAssignments,
        operatorFlags
      }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.saved", {
      planId: plan.id,
      planDate: plan.planDate,
      savedAt: plan.savedAt,
      sourceSessionId: req.body?.audit?.sessionId,
      operatorFlags,
      changedOperatorRefs,
      refreshOrderPool: true,
      restoredSnapshotId: req.params.snapshotId
    });
    res.json({ plan, restoredSnapshot: restored.restoredSnapshot, operatorFlags, coAssignments });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/plans/:id/shipped-orders.csv", async (req, res, next) => {
  try {
    const plan = await getDispatchPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });
    const statuses = await listDriverJobStatuses({ planId: plan.id });
    const csv = shippedDispatchCsv(plan, statuses);
    const safeDate = String(plan.planDate || "dispatch").replaceAll(/[^0-9-]/g, "");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipped-orders-${safeDate || plan.id}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/:id", async (req, res, next) => {
  try {
    const plan = await getDispatchPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/:id/revision", async (req, res, next) => {
  try {
    const revision = await getDispatchPlanRevision(req.params.id);
    if (!revision) return res.status(404).json({ error: "Dispatch plan not found" });
    res.json(revision);
  } catch (error) {
    next(error);
  }
});

function reportDispatchSaveTiming(req, res, next) {
  const startedAt = Date.now();
  res.once("finish", () => {
    console.info("[dispatch-save-timing]", JSON.stringify({
      planId: String(req.params?.id || ""),
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      saveMode: dispatchPlanSaveMode(req.body),
      forceSave: req.body?.forceSave === true
    }));
  });
  next();
}

app.put("/api/dispatch/plans/:id", reportDispatchSaveTiming, requireOperator, requireDispatcher, async (req, res, next) => {
  let previousPlan = null;
  try {
    previousPlan = await getDispatchPlan(req.params.id);
    if (!previousPlan) return res.status(404).json({ error: "Dispatch plan not found" });
    await requireDispatchPlanEditLease(req, previousPlan.planDate);
    const forceSave = req.body?.forceSave === true;
    const requestedPlanDate = String(req.body?.planDate || req.body?.date || previousPlan?.planDate || "").slice(0, 10);
    const existingPlanDate = String(previousPlan?.planDate || "").slice(0, 10);
    if (previousPlan && requestedPlanDate && existingPlanDate && requestedPlanDate !== existingPlanDate) {
      throw new DispatchPlanDateMismatchError({
        planId: req.params.id,
        expectedPlanDate: existingPlanDate,
        payloadPlanDate: requestedPlanDate
      });
    }
    const saveMode = dispatchPlanSaveMode(req.body);
    const requestedOrders = Array.isArray(req.body?.orders) ? req.body.orders : [];
    const requestedTrucks = Array.isArray(req.body?.trucks) ? req.body.trucks : [];
    let cleanOrders = saveMode === "truck_sequence" && previousPlan
      ? previousPlan.orders || []
      : requestedOrders;
    let cleanTrucks = saveMode === "truck_sequence" && previousPlan
      ? mergeDispatchTruckSequence(previousPlan.trucks || [], requestedTrucks)
      : requestedTrucks;
    if (config.dispatch?.driverOrientedPlanning) {
      cleanTrucks = normalizeDispatchPlanLoadAssignments({ ...previousPlan, trucks: cleanTrucks }).trucks;
    }
    const canonicalCandidate = await canonicalizeDispatchCustomOrdersInPlan({
      ...previousPlan,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    }, { previousPlan });
    cleanOrders = sanitizeDispatchPlanOrders(canonicalCandidate.orders || []);
    cleanTrucks = canonicalCandidate.trucks || [];
    const scheduleCandidate = await overlayDispatchLockedLoadSchedule(previousPlan, {
      ...previousPlan,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    cleanTrucks = scheduleCandidate.trucks || [];
    const changedScmRefs = changedDispatchScmRefs(previousPlan, {
      ...previousPlan,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    await assertScmReconciliationOrderEditable({ orderRefs: changedScmRefs });
    await assertNoRestrictedScmDispatchOrders(
      changedPlacedDispatchScmAssignmentRefs(previousPlan, {
        ...previousPlan,
        orders: cleanOrders,
        trucks: cleanTrucks
      }),
      "save this plan"
    );
    const duplicateDrivers = config.dispatch?.driverOrientedPlanning ? [] : dispatchDuplicateDriverAssignments(cleanTrucks);
    if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
    const dependencyStructureChanges = await assertNoConsolidationStructureConflict(
      previousPlan,
      { orders: cleanOrders }
    );
    const explicitOperatorAlertRefs = Array.isArray(req.body?.audit?.details?.operatorAlertRefs)
      ? req.body.audit.details.operatorAlertRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
      : [];
    const refreshOrderPool = req.body?.audit?.details?.refreshOrderPool === true;
    if (
      previousPlan
      && !explicitOperatorAlertRefs.length
      && !dispatchPlanDataChanged(
        { orders: previousPlan.orders || [], trucks: previousPlan.trucks || [] },
        { orders: cleanOrders, trucks: cleanTrucks }
      )
    ) {
      return res.json({ ...previousPlan, operatorFlags: null, noChange: true });
    }
    const nextPlanForValidation = {
      ...previousPlan,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    };
    const assignmentConflicts = await dispatchLoadAssignmentConflicts(previousPlan, nextPlanForValidation);
    if (assignmentConflicts.length) return sendDispatchLoadAssignmentConflictResponse(res, assignmentConflicts);
    const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan || {}, {
      ...nextPlanForValidation,
      id: req.params.id
    });
    if (dateConflicts.length) return sendDispatchPlanDateConflictResponse(res, dateConflicts);
    const coSequenceConflicts = await findChangedDispatchCoSequenceConflicts(previousPlan, {
      id: req.params.id,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    if (coSequenceConflicts.length) return sendDispatchCoSequenceConflictResponse(res, coSequenceConflicts);
    const dependencyConflicts = await validateDispatchPlanDependencies({
      id: req.params.id,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    if (dependencyConflicts.length) return sendDispatchDependencyConflictResponse(res, dependencyConflicts);
    const plan = await saveDispatchPlanSnapshot(req.params.id, {
      orders: cleanOrders,
      trucks: cleanTrucks,
      summary: await dispatchPlanSummaryWithSetup(req.body?.summary || {}),
      baseRevision: forceSave || saveMode === "truck_sequence" ? null : req.body?.baseRevision,
      planDate: req.body?.planDate || req.body?.date || "",
      sessionId: req.body?.audit?.sessionId || ""
    });
    const followupWarnings = [];
    const followupContext = {
      plan,
      committedAction: "saved",
      sessionId: req.body?.audit?.sessionId || "",
      operator: req.operator,
      followupWarnings
    };
    await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "order_dependencies",
      code: "DISPATCH_PLAN_DEPENDENCY_SYNC_FAILED",
      label: "Order dependency synchronization"
    }, () => syncOrderDependenciesFromDispatchPlan(plan, {
      allowEstablishedUngroupTargets: dependencyStructureChanges.safeUngroupTargets
    }));
    const coAssignments = await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "co_assignments",
      code: "DISPATCH_PLAN_CO_ASSIGNMENT_FAILED",
      label: "CO assignment synchronization"
    }, () => applyDispatchPlanCoAssignments(plan));
    const scmSchedule = await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "scm_schedule",
      code: "DISPATCH_PLAN_SCM_SYNC_FAILED",
      label: "SCM schedule synchronization"
    }, () => syncScmScheduleFromDispatchPlan(plan, {
      updatedBy: req.body?.audit?.sessionId || "dispatch-plan-save"
    }));
    const changedOperatorRefs = [
      ...new Set([...changedDispatchOperatorRefs(previousPlan || {}, plan), ...explicitOperatorAlertRefs])
    ];
    let operatorFlags = null;
    const shouldApplyOperatorFlags = plan.status === "confirmed"
      && (changedOperatorRefs.length > 0 || dispatchOperatorImpactChanged(previousPlan || {}, plan));
    if (shouldApplyOperatorFlags) {
      operatorFlags = await runDispatchPlanPostCommitFollowup({
        ...followupContext,
        stage: "delivery_materialization",
        code: "DISPATCH_PLAN_DELIVERY_MATERIALIZATION_FAILED",
        label: "Delivery order materialization"
      }, () => applyConfirmedDispatchPlanToDelivery(plan, {
        forceOrderRefs: changedOperatorRefs
      }));
    }
    if (req.body?.audit) {
      await writeDispatchAudit({
        ...req.body.audit,
        action: req.body.audit.action || "dispatch_plan_saved",
        entityType: "plan",
        entityId: String(plan.id),
        planId: plan.id,
        planDate: plan.planDate,
        details: {
          ...(req.body.audit.details || {}),
          orderCount: plan.orders.length,
          truckCount: plan.trucks.length,
          saveMode,
          forceSave,
          coAssignments,
          scmSchedule,
          operatorFlags,
          operatorFlagsSkipped: plan.status === "confirmed" && !shouldApplyOperatorFlags,
          followupWarnings
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: plan.id, planDate: plan.planDate, savedAt: plan.savedAt, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs, refreshOrderPool, scmSchedule, forceSave, followupWarnings });
    res.json({ ...plan, operatorFlags, scmSchedule, followupWarnings });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    if (error instanceof DispatchPlanDateMismatchError) {
      await writeDispatchAudit({
        action: "dispatch.plan.date_mismatch_blocked",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: error.expectedPlanDate || previousPlan?.planDate || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedPlanDate: error.expectedPlanDate,
          payloadPlanDate: error.payloadPlanDate,
          saveMode: dispatchPlanSaveMode(req.body),
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return res.status(409).json({
        error: error.message,
        code: error.code,
        expectedPlanDate: error.expectedPlanDate,
        payloadPlanDate: error.payloadPlanDate
      });
    }
    if (error instanceof StaleDispatchPlanSaveError) {
      await writeDispatchAudit({
        action: "dispatch.plan.stale_save_debug",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
          saveMode: dispatchPlanSaveMode(req.body),
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return sendStaleDispatchPlanResponse(res, error);
    }
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/confirm", requireOperator, requireDispatcher, async (req, res, next) => {
  let previousPlan = null;
  try {
    previousPlan = await getDispatchPlan(req.params.id);
    if (!previousPlan) return res.status(404).json({ error: "Dispatch plan not found" });
    await requireDispatchPlanEditLease(req, previousPlan.planDate);
    const hasSubmittedSnapshot = Array.isArray(req.body?.orders) || Array.isArray(req.body?.trucks);
    let planForConfirm = previousPlan;
    let dependencyStructureChanges = { safeGroupingTargets: [], safeUngroupTargets: [] };
    if (hasSubmittedSnapshot) {
      const requestedPlanDate = String(req.body?.planDate || req.body?.date || previousPlan?.planDate || "").slice(0, 10);
      const existingPlanDate = String(previousPlan?.planDate || "").slice(0, 10);
      if (requestedPlanDate && existingPlanDate && requestedPlanDate !== existingPlanDate) {
        throw new DispatchPlanDateMismatchError({
          planId: req.params.id,
          expectedPlanDate: existingPlanDate,
          payloadPlanDate: requestedPlanDate
        });
      }
      let requestedOrders = Array.isArray(req.body?.orders) ? req.body.orders : previousPlan.orders || [];
      let requestedTrucks = Array.isArray(req.body?.trucks) ? req.body.trucks : previousPlan.trucks || [];
      if (config.dispatch?.driverOrientedPlanning) {
        requestedTrucks = normalizeDispatchPlanLoadAssignments({ ...previousPlan, trucks: requestedTrucks }).trucks;
      }
      const canonicalCandidate = await canonicalizeDispatchCustomOrdersInPlan({
        ...previousPlan,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      }, { previousPlan });
      requestedOrders = sanitizeDispatchPlanOrders(canonicalCandidate.orders || []);
      requestedTrucks = canonicalCandidate.trucks || [];
      const scheduleCandidate = await overlayDispatchLockedLoadSchedule(previousPlan, {
        ...previousPlan,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      });
      requestedTrucks = scheduleCandidate.trucks || [];
      const changedScmRefs = changedDispatchScmRefs(previousPlan, {
        ...previousPlan,
        orders: requestedOrders,
        trucks: requestedTrucks
      });
      await assertScmReconciliationOrderEditable({ orderRefs: changedScmRefs });
      await assertNoRestrictedScmDispatchOrders(
        changedPlacedDispatchScmAssignmentRefs(previousPlan, {
          ...previousPlan,
          orders: requestedOrders,
          trucks: requestedTrucks
        }),
        "confirm this plan"
      );
      const duplicateDrivers = config.dispatch?.driverOrientedPlanning ? [] : dispatchDuplicateDriverAssignments(requestedTrucks);
      if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
      dependencyStructureChanges = await assertNoConsolidationStructureConflict(
        previousPlan,
        { orders: requestedOrders }
      );
      const submittedPlanForValidation = {
        ...previousPlan,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      };
      const assignmentConflicts = await dispatchLoadAssignmentConflicts(
        previousPlan,
        submittedPlanForValidation,
        { requireAssignments: true }
      );
      if (assignmentConflicts.length) return sendDispatchLoadAssignmentConflictResponse(res, assignmentConflicts);
      const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan || {}, {
        ...submittedPlanForValidation,
        id: req.params.id
      });
      if (dateConflicts.length) return sendDispatchPlanDateConflictResponse(res, dateConflicts);
      const coSequenceConflicts = await findChangedDispatchCoSequenceConflicts(previousPlan, {
        id: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      });
      if (coSequenceConflicts.length) return sendDispatchCoSequenceConflictResponse(res, coSequenceConflicts);
      const dependencyConflicts = await validateDispatchPlanDependencies({
        id: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      });
      if (dependencyConflicts.length) return sendDispatchDependencyConflictResponse(res, dependencyConflicts);
      if (dispatchConfirmPlanDataChanged(
        { orders: previousPlan.orders || [], trucks: previousPlan.trucks || [] },
        { orders: requestedOrders, trucks: requestedTrucks }
      )) {
        planForConfirm = await saveDispatchPlanSnapshot(req.params.id, {
          orders: requestedOrders,
          trucks: requestedTrucks,
          summary: await dispatchPlanSummaryWithSetup(req.body?.summary || {}),
          baseRevision: req.body?.baseRevision,
          planDate: req.body?.planDate || req.body?.date || "",
          sessionId: req.body?.audit?.sessionId || ""
        });
      }
    }
    const placedScmRefs = dispatchPlacedScmRefs(planForConfirm);
    await assertScmReconciliationOrderEditable({ orderRefs: placedScmRefs });
    await assertNoRestrictedScmDispatchOrders(placedScmRefs, "confirm this plan");
    const duplicateDrivers = config.dispatch?.driverOrientedPlanning ? [] : dispatchDuplicateDriverAssignments(planForConfirm?.trucks || []);
    if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
    const finalAssignmentConflicts = await dispatchLoadAssignmentConflicts(previousPlan, planForConfirm, { requireAssignments: true });
    if (finalAssignmentConflicts.length) return sendDispatchLoadAssignmentConflictResponse(res, finalAssignmentConflicts);
    const finalDependencyConflicts = await validateDispatchPlanDependencies(planForConfirm);
    if (finalDependencyConflicts.length) return sendDispatchDependencyConflictResponse(res, finalDependencyConflicts);
    const binConfirmationRequired = binDispatchOrders(planForConfirm).length > 0;
    let binConfirmationCapability = null;
    if (binConfirmationRequired) {
      const pilotAuthorized = operatorHasAnyRole(req.operator, ["admin", "dispatcher"]);
      await authorizeMbtPhase3Capability({ capability: "binDispatch", pilotAuthorized });
      binConfirmationCapability = {
        environmentEnabled: true,
        databaseEnabled: true,
        pilotAuthorized: true
      };
    }
    const plan = binConfirmationRequired
      ? await confirmMbtBinDispatchPlan({
          actor: {
            operatorId: String(req.operator?.id || ""),
            roles: normalizedOperatorRoles(req.operator)
          },
          planId: req.params.id,
          note: req.body?.note || ""
        }, { capability: binConfirmationCapability })
      : await confirmDispatchPlan(req.params.id, { note: req.body?.note || "" });
    const followupWarnings = [];
    const followupContext = {
      plan,
      committedAction: "confirmed",
      sessionId: req.body?.audit?.sessionId || "",
      operator: req.operator,
      followupWarnings
    };
    await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "order_dependencies",
      code: "DISPATCH_PLAN_DEPENDENCY_SYNC_FAILED",
      label: "Order dependency synchronization"
    }, () => syncOrderDependenciesFromDispatchPlan(plan, {
      allowEstablishedUngroupTargets: dependencyStructureChanges.safeUngroupTargets
    }));
    const coAssignments = await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "co_assignments",
      code: "DISPATCH_PLAN_CO_ASSIGNMENT_FAILED",
      label: "CO assignment synchronization"
    }, () => applyDispatchPlanCoAssignments(plan));
    const scmSchedule = await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "scm_schedule",
      code: "DISPATCH_PLAN_SCM_SYNC_FAILED",
      label: "SCM schedule synchronization"
    }, () => syncScmScheduleFromDispatchPlan(plan, {
      updatedBy: req.body?.audit?.sessionId || "dispatch-plan-confirm"
    }));
    const changedOperatorRefs = [...dispatchOperatorAssignmentMap(plan).keys()];
    const operatorFlags = await runDispatchPlanPostCommitFollowup({
      ...followupContext,
      stage: "delivery_materialization",
      code: "DISPATCH_PLAN_DELIVERY_MATERIALIZATION_FAILED",
      label: "Delivery order materialization"
    }, () => applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs: changedOperatorRefs }));
    await writeDispatchAudit({
      action: "dispatch_plan_confirmed",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: {
        ...(req.body?.audit?.details || {}),
        status: plan.status,
        submittedSnapshot: hasSubmittedSnapshot,
        savedSnapshotBeforeConfirm: String(planForConfirm?.revision || "") !== String(previousPlan?.revision || ""),
        coAssignments,
        scmSchedule,
        operatorFlags,
        followupWarnings
      }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.confirmed", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs, refreshOrderPool: true, scmSchedule, followupWarnings });
    res.json({ ...plan, operatorFlags, scmSchedule, followupWarnings });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    if (error instanceof DispatchPlanDateMismatchError) {
      await writeDispatchAudit({
        action: "dispatch.plan.date_mismatch_blocked",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: error.expectedPlanDate || previousPlan?.planDate || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedPlanDate: error.expectedPlanDate,
          payloadPlanDate: error.payloadPlanDate,
          saveMode: "confirm",
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return res.status(409).json({
        error: error.message,
        code: error.code,
        expectedPlanDate: error.expectedPlanDate,
        payloadPlanDate: error.payloadPlanDate
      });
    }
    if (error instanceof StaleDispatchPlanSaveError) {
      await writeDispatchAudit({
        action: "dispatch.plan.stale_save_debug",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
          saveMode: "confirm",
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return sendStaleDispatchPlanResponse(res, error);
    }
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/reopen", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const existingPlan = await getDispatchPlan(req.params.id);
    if (!existingPlan) return res.status(404).json({ error: "Dispatch plan not found" });
    await requireDispatchPlanEditLease(req, existingPlan.planDate);
    const plan = await reopenDispatchPlan(req.params.id, { note: req.body?.note || "" });
    await writeDispatchAudit({
      action: "dispatch_plan_reopened",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { status: plan.status }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.reopened", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId, refreshOrderPool: true });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plan", async (req, res, next) => {
  try {
    const plan = await getCurrentDispatchPlan({ planDate: req.query.date });
    if (plan) return res.json(plan);
    const text = await fs.readFile(dispatchPlanPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!text) return res.json({ savedAt: "", orders: [], trucks: [] });
    res.json(JSON.parse(text));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/setup", async (req, res, next) => {
  try {
    const includeInactive = ["1", "true", "yes"].includes(String(req.query.includeInactive || "").trim().toLowerCase());
    if (includeInactive && !operatorHasAnyRole(req.operator, ["dispatcher", "admin"])) {
      return sendRoleForbidden(res, req.operator, "Dispatcher account required");
    }
    res.json(await readDispatchSetup({ includeInactive }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/setup", requireDispatcher, async (req, res, next) => {
  try {
    const payload = await withDispatchFleetPlanningLock(() => writeDispatchSetup({
        drivers: Array.isArray(req.body?.drivers) ? req.body.drivers : [],
        trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : [],
        ownYards: Array.isArray(req.body?.ownYards) ? req.body.ownYards : undefined,
        samsara: req.body?.samsara || undefined,
        planning: req.body?.planning || undefined
      }, { includeInactive: true }));
    emitAppEvent("dispatch.setup.updated", {
      driverCount: payload.drivers.filter((driver) => driver.active !== false).length,
      truckCount: payload.trucks.filter((truck) => truck.active !== false).length
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/setup/trucks/:id/capabilities", requireDispatcher, async (req, res, next) => {
  res.setHeader("cache-control", "no-store");
  try {
    const idempotencyKey = String(req.get("idempotency-key") || "").trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        code: "MBT_IDEMPOTENCY_KEY_REQUIRED",
        error: "An Idempotency-Key header is required."
      });
    }
    const suppliedCorrelationId = String(req.get("x-correlation-id") || "").trim();
    const suppliedRequestId = String(req.get("x-request-id") || "").trim();
    const result = await withDispatchFleetPlanningLock(() => updateDispatchTruckCapabilities({
      actor: {
        operatorId: String(req.operator?.id || "").trim(),
        roles: normalizedOperatorRoles(req.operator)
      },
      truckId: req.params.id,
      expectedRevision: req.body?.expectedRevision,
      capability: req.body?.capability,
      reason: req.body?.reason,
      idempotencyKey,
      correlationId: suppliedCorrelationId && suppliedCorrelationId.length <= 160 ? suppliedCorrelationId : crypto.randomUUID(),
      requestId: suppliedRequestId && suppliedRequestId.length <= 160 ? suppliedRequestId : crypto.randomUUID()
    }));
    res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
    emitAppEvent("dispatch.setup.updated", {
      resourceType: "truck",
      resourceId: req.params.id,
      capabilityChanged: true
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/dispatch/setup/drivers/:id/active", requireDispatcher, async (req, res, next) => {
  try {
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active must be true or false." });
    const change = await withDispatchFleetPlanningLock(async () => {
      const drivers = await listDispatchDrivers({ activeOnly: false });
      const current = drivers.find((driver) => String(driver.id) === String(req.params.id));
      if (!current) return { notFound: true };
      if (current.active === req.body.active) return { current, unchanged: true };
      const conflicts = req.body.active ? [] : await dispatchFleetDisableConflicts({ driver: current });
      if (conflicts.length) return { current, conflicts };
      return { current, result: await setDispatchDriverActive(current.id, req.body.active) };
    });
    if (change.notFound) return res.status(404).json({ error: "Driver not found." });
    if (change.unchanged) return res.json({ driver: change.current, unchanged: true });
    if (change.conflicts?.length) {
      return res.status(409).json({
        code: "DISPATCH_FLEET_IN_USE",
        error: `Cannot disable ${change.current.name || change.current.login}. Reassign or finish the active work first. ${change.conflicts[0].message}`,
        conflicts: change.conflicts
      });
    }
    const { result } = change;
    if (!result) return res.status(404).json({ error: "Driver not found." });
    if (!result.driver.active) await revokeDispatchDriverSessions(result.driver.login);
    await writeDispatchAudit({
      action: result.driver.active ? "dispatch_driver_enabled" : "dispatch_driver_disabled",
      entityType: "dispatch_driver",
      entityId: result.driver.id,
      operatorId: req.operator?.id,
      operatorName: req.operator?.display_name || req.operator?.username,
      source: "dispatch-setup",
      before: result.before,
      after: result.driver,
      details: { login: result.driver.login }
    }).catch(() => null);
    emitAppEvent("dispatch.setup.updated", {
      resourceType: "driver",
      resourceId: result.driver.id,
      active: result.driver.active
    });
    res.json({ driver: result.driver });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/dispatch/setup/trucks/:id/active", requireDispatcher, async (req, res, next) => {
  try {
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active must be true or false." });
    const change = await withDispatchFleetPlanningLock(async () => {
      const trucks = await listDispatchTrucks({ activeOnly: false });
      const current = trucks.find((truck) => String(truck.id) === String(req.params.id));
      if (!current) return { notFound: true };
      if (current.active === req.body.active) return { current, unchanged: true };
      const conflicts = req.body.active ? [] : await dispatchFleetDisableConflicts({ truck: current });
      if (conflicts.length) return { current, conflicts };
      return { current, result: await setDispatchTruckActive(current.id, req.body.active) };
    });
    if (change.notFound) return res.status(404).json({ error: "Truck not found." });
    if (change.unchanged) return res.json({ truck: change.current, unchanged: true });
    if (change.conflicts?.length) {
      return res.status(409).json({
        code: "DISPATCH_FLEET_IN_USE",
        error: `Cannot disable ${change.current.plate}. Reassign or finish the active work first. ${change.conflicts[0].message}`,
        conflicts: change.conflicts
      });
    }
    const { result } = change;
    if (!result) return res.status(404).json({ error: "Truck not found." });
    await writeDispatchAudit({
      action: result.truck.active ? "dispatch_truck_enabled" : "dispatch_truck_disabled",
      entityType: "dispatch_truck",
      entityId: result.truck.id,
      truckId: result.truck.id,
      operatorId: req.operator?.id,
      operatorName: req.operator?.display_name || req.operator?.username,
      source: "dispatch-setup",
      before: result.before,
      after: result.truck,
      details: { plate: result.truck.plate }
    }).catch(() => null);
    emitAppEvent("dispatch.setup.updated", {
      resourceType: "truck",
      resourceId: result.truck.id,
      active: result.truck.active
    });
    res.json({ truck: result.truck });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/samsara/test", async (req, res, next) => {
  try {
    const setup = await readDispatchSetup();
    res.json(await testSamsaraConnection({ localTrucks: setup.trucks || [] }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/samsara/driver-login-test", async (req, res, next) => {
  try {
    const driverLogin = String(req.body?.driverLogin || "").trim().toLowerCase();
    const account = req.body?.account === "secondary" ? "secondary" : "primary";
    const setup = await readDispatchSetup();
    const driver = (setup.drivers || []).find((item) => String(item.login || "").trim().toLowerCase() === driverLogin);
    if (!driver) return res.status(404).json({ error: "Driver was not found in Dispatch Setup." });
    if (!driverSamsaraWorkflowEnabled(driver)) return driverSamsaraDisabledResponse(res);
    const username = samsaraUsernameForDriver(driver, account);
    if (!username) return res.status(400).json({ error: `No Samsara ${account} login ID is saved for this driver.` });
    const samsaraDriver = await findSamsaraDriverByUsername(username);
    if (!samsaraDriver) return res.status(404).json({ error: `Samsara driver username ${username} was not found.` });
    res.json({
      username,
      account,
      driverName: driver.name || "",
      samsaraDriver: {
        id: samsaraDriver.id,
        name: samsaraDriver.name,
        username: samsaraDriver.username,
        status: samsaraDriver.driverActivationStatus || ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders", async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    const search = req.query.search ? String(req.query.search) : "";
    res.json(await listDispatchOrdersForResponse({ type, search }));
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/custom-orders", requireDispatcher, async (req, res, next) => {
  try {
    const includeCancelled = String(req.query.includeCancelled ?? "true").toLowerCase() !== "false";
    res.json(await dispatchCustomOrdersForManagement({
      includeCancelled,
      search: req.query.search || ""
    }));
  } catch (error) {
    next(error);
  }
});

function dispatchCustomOrderId(value) {
  const id = String(value || "").trim();
  const numericId = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(numericId) || numericId <= 0) {
    throw Object.assign(new Error("A valid Custom Order ID is required."), {
      status: 400,
      code: "DISPATCH_CUSTOM_ORDER_ID_INVALID"
    });
  }
  return id;
}

app.post("/api/dispatch/custom-orders", requireDispatcher, async (req, res, next) => {
  try {
    const actor = req.operator?.display_name || req.operator?.username || operatorId(req);
    const created = await withDispatchFleetPlanningLock(async () => {
      await assertNoSnapshotDispatchRefCollision(req.body?.refNumber ?? req.body?.ref_number);
      return createDispatchCustomOrder(req.body || {}, actor);
    });
    const managementRows = await dispatchCustomOrdersForManagement({
      includeCancelled: true,
      search: created.refNumber
    });
    const order = managementRows.find((row) => String(row.id) === String(created.id)) || created;
    await writeDispatchAudit({
      action: "dispatch_custom_order_created",
      entityType: "custom_order",
      entityId: created.id,
      orderId: created.refNumber,
      operatorId: req.operator?.id,
      operatorName: actor,
      source: "dispatch",
      after: created,
      details: {
        pickupLocation: created.pickupLocation,
        dropoffLocation: created.dropoffLocation,
        weightLbs: created.weightLbs,
        stopMinutes: created.stopMinutes
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", {
      source: "custom-order",
      change: "custom_order_created",
      orderId: created.refNumber,
      refreshOrderPool: true
    });
    res.status(201).json({ order: order || created });
  } catch (error) {
    next(error);
  }
});

async function updateDispatchCustomOrderRoute(req, res, next) {
  try {
    const customOrderId = dispatchCustomOrderId(req.params.id);
    const actor = req.operator?.display_name || req.operator?.username || operatorId(req);
    const mutation = await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      const current = await getDispatchCustomOrderForUpdate(customOrderId);
      if (!current) return { notFound: true };
      await assertDispatchCustomOrderMutable(current);
      const updated = await updateDispatchCustomOrder(customOrderId, req.body || {}, actor);
      return { current, updated };
    });
    if (mutation.notFound) return res.status(404).json({ error: "Custom Order not found." });
    const { current, updated } = mutation;
    const managementRows = await dispatchCustomOrdersForManagement({
      includeCancelled: true,
      search: updated.refNumber
    });
    const order = managementRows.find((row) => String(row.id) === String(updated.id)) || updated;
    await writeDispatchAudit({
      action: "dispatch_custom_order_updated",
      entityType: "custom_order",
      entityId: updated.id,
      orderId: updated.refNumber,
      operatorId: req.operator?.id,
      operatorName: actor,
      source: "dispatch",
      before: current,
      after: updated
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", {
      source: "custom-order",
      change: "custom_order_updated",
      orderId: updated.refNumber,
      refreshOrderPool: true
    });
    res.json({ order });
  } catch (error) {
    next(error);
  }
}

app.put("/api/dispatch/custom-orders/:id", requireDispatcher, updateDispatchCustomOrderRoute);
app.patch("/api/dispatch/custom-orders/:id", requireDispatcher, updateDispatchCustomOrderRoute);

app.delete("/api/dispatch/custom-orders/:id", requireDispatcher, async (req, res, next) => {
  try {
    const customOrderId = dispatchCustomOrderId(req.params.id);
    const actor = req.operator?.display_name || req.operator?.username || operatorId(req);
    const mutation = await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      const current = await getDispatchCustomOrderForUpdate(customOrderId);
      if (!current) return { notFound: true };
      await assertDispatchCustomOrderMutable(current);
      const cancelled = await cancelDispatchCustomOrder(customOrderId, actor);
      return { current, cancelled };
    });
    if (mutation.notFound) return res.status(404).json({ error: "Custom Order not found." });
    const { current, cancelled } = mutation;
    if (!cancelled) {
      return res.status(409).json({ error: "This Custom Order changed before cancellation completed. Refresh and try again." });
    }
    const managementRows = await dispatchCustomOrdersForManagement({
      includeCancelled: true,
      search: cancelled.refNumber
    });
    const order = managementRows.find((row) => String(row.id) === String(cancelled.id)) || cancelled;
    await writeDispatchAudit({
      action: "dispatch_custom_order_cancelled",
      entityType: "custom_order",
      entityId: cancelled.id,
      orderId: cancelled.refNumber,
      operatorId: req.operator?.id,
      operatorName: actor,
      source: "dispatch",
      before: current,
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", {
      source: "custom-order",
      change: "custom_order_cancelled",
      orderId: cancelled.refNumber,
      refreshOrderPool: true
    });
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/sales-order-methods", async (req, res, next) => {
  try {
    res.json(await searchSalesOrderMethodOverrides({
      search: req.query.search || "",
      limit: req.query.limit || 30
    }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/sales-order-methods/:tranid", async (req, res, next) => {
  try {
    const before = (await searchSalesOrderMethodOverrides({ search: req.params.tranid, limit: 1 }))[0] || null;
    const updated = await updateSalesOrderLocalMethod(req.params.tranid, {
      method: req.body?.method,
      updatedBy: operatorId(req)
    });
    if (!updated) return res.status(404).json({ error: "Sales order not found in local DB. Sync the order first, then update local method." });
    await writeDispatchAudit({
      action: "sales_order_local_method_updated",
      entityType: "sales_order",
      entityId: updated.netsuiteId,
      orderId: updated.tranid,
      operatorId: req.operator?.id,
      operatorName: req.operator?.display_name || req.operator?.username,
      before,
      after: updated,
      details: {
        requestedMethod: req.body?.method,
        netSuiteMethod: updated.netsuiteMethod,
        overrideActive: updated.overrideActive
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: updated.tranid, change: "sales_order_local_method" });
    res.json({ updated, orders: await listDispatchOrdersForResponse({ type: "SO" }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/order-dependencies", async (req, res, next) => {
  try {
    res.json(await listOrderDependencies({
      salesOrderRef: req.query.salesOrderRef || "",
      transferOrderRef: req.query.transferOrderRef || "",
      includeCancelled: req.query.includeCancelled === "true"
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/order-dependencies/options", async (req, res, next) => {
  try {
    res.json(await getOrderDependencyOptions({
      dispatchTargetRef: req.query.dispatchTargetRef || "",
      salesOrderRef: req.query.salesOrderRef || "",
      transferOrderRef: req.query.transferOrderRef || "",
      planDate: req.query.planDate || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/order-dependencies", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req, req.body?.planDate || req.body?.date || "");
    const dependency = await createOrderDependency({
      dispatchTargetRef: req.body?.dispatchTargetRef,
      salesOrderRef: req.body?.salesOrderRef,
      transferOrderRef: req.body?.transferOrderRef,
      planDate: req.body?.planDate,
      targetSignature: req.body?.targetSignature,
      mode: req.body?.mode,
      allocations: req.body?.allocations || [],
      operatorId: req.operator?.id
    });
    emitAppEvent("dispatch.orders.updated", { source: "order-dependency", orderId: dependency.salesOrderRef, refreshOrderPool: true });
    res.status(201).json({
      dependency,
      ...await dispatchMutationOrderResponse(req, [
        dependency.dispatchTargetRef,
        dependency.salesOrderRef,
        dependency.transferOrderRef
      ])
    });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.patch("/api/dispatch/order-dependencies/:id/mode", async (req, res, next) => {
  try {
    const planDate = req.body?.planDate || req.body?.date || "";
    await requireDispatchPlanEditLease(req, planDate);
    const dependency = await updateOrderDependencyMode(
      req.params.id,
      req.body?.mode,
      req.operator?.id,
      planDate
    );
    emitAppEvent("dispatch.orders.updated", { source: "order-dependency-mode", orderId: dependency.salesOrderRef, refreshOrderPool: true });
    res.json({
      dependency,
      ...await dispatchMutationOrderResponse(req, [
        dependency.dispatchTargetRef,
        dependency.salesOrderRef,
        dependency.transferOrderRef
      ])
    });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.delete("/api/dispatch/order-dependencies/:id", async (req, res, next) => {
  try {
    const planDate = req.body?.planDate || req.query?.planDate || "";
    await requireDispatchPlanEditLease(req, planDate);
    const cancelled = await cancelOrderDependency(req.params.id, req.operator?.id, planDate);
    emitAppEvent("dispatch.orders.updated", { source: "order-dependency-unlink", refreshOrderPool: true });
    res.json({
      cancelled,
      ...await dispatchMutationOrderResponse(req, req.body?.orderRefs || [])
    });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/loaded-orders", async (req, res, next) => {
  try {
    if (req.publicSalesAccess || req.operator?.publicSales) {
      return res.status(403).json({ error: "Staff Sales login required.", redirect: "/sales" });
    }
    res.json(await listYardMovements({
      from: req.query.from,
      to: req.query.to,
      yard: req.query.yard,
      search: req.query.search,
      itemSearch: req.query.itemSearch,
      direction: req.query.direction,
      orderType: req.query.orderType,
      allowedYardLocationIds: movementAllowedYardLocationIds(req)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/loaded-orders/detail", async (req, res, next) => {
  try {
    if (req.publicSalesAccess || req.operator?.publicSales) {
      return res.status(403).json({ error: "Staff Sales login required.", redirect: "/sales" });
    }
    const detail = await getYardMovementDetail({
      direction: req.query.direction,
      orderType: req.query.orderType,
      orderId: req.query.orderId,
      from: req.query.from,
      to: req.query.to,
      allowedYardLocationIds: movementAllowedYardLocationIds(req)
    });
    if (!detail) return res.status(404).json({ error: "Yard movement not found." });
    return res.json(detail);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/dispatch/loaded-orders/export.csv", async (req, res, next) => {
  try {
    if (req.publicSalesAccess || req.operator?.publicSales) {
      return res.status(403).json({ error: "Staff Sales login required.", redirect: "/sales" });
    }
    await sendLoadedOrdersCsv(req, res, {
      allowedYardLocationIds: movementAllowedYardLocationIds(req)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/transfer-dependencies/candidates", async (req, res, next) => {
  try {
    if ((req.query.reviewStatus || "open") === "open") {
      await refreshTransferDependencySalesOrderAllocations();
    }
    res.json(await listTransferDependencyCandidates({
      search: req.query.search || "",
      salesOrderId: req.query.salesOrderId || null,
      reviewStatus: req.query.reviewStatus || "open"
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/candidates/:salesOrderId/review", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    const candidate = await reviewTransferDependencyCandidate({
      salesOrderId: req.params.salesOrderId,
      operatorId: req.operator?.id
    });
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "reviewed-no-transfer",
      orderId: candidate.salesOrderRef
    });
    res.json(candidate);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/transfer-dependencies/candidates/:salesOrderId/review", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    const candidate = await reopenTransferDependencyCandidate({
      salesOrderId: req.params.salesOrderId,
      operatorId: req.operator?.id
    });
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "review-reopened",
      orderId: candidate.salesOrderRef
    });
    res.json(candidate);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/transfer-dependencies/candidates/:salesOrderId/inventory", async (req, res, next) => {
  try {
    res.json(await getDependencyInventoryMatrix(req.params.salesOrderId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/candidates/:salesOrderId/refresh-inventory", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await refreshTransferDependencySalesOrderAllocations({
      salesOrderId: req.params.salesOrderId,
      force: req.body?.force === true
    });
    const candidates = await listTransferDependencyCandidates({ salesOrderId: req.params.salesOrderId });
    const currentInventory = await getDependencyInventoryMatrix(req.params.salesOrderId);
    const itemIds = [...new Set((currentInventory.orderLines || [])
      .map((line) => Number(line.itemId)).filter(Number.isInteger))];
    if (itemIds.length) await refreshTransferDependencyInventory(itemIds);
    const inventory = itemIds.length
      ? await getDependencyInventoryMatrix(req.params.salesOrderId)
      : currentInventory;
    if (req.body?.includeCandidate === true) {
      return res.json({ inventory, candidate: candidates[0] || null });
    }
    return res.json(inventory);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/transfer-dependencies/batches/:id", async (req, res, next) => {
  try {
    const batch = await getTransferDependencyBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: "Dependency batch not found." });
    res.json(batch);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/suggestions", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await refreshTransferDependencySalesOrderAllocations({
      salesOrderId: req.body?.salesOrderId,
      force: true
    });
    const candidates = await listTransferDependencyCandidates({ salesOrderId: req.body?.salesOrderId });
    const itemIds = candidates.flatMap((order) => order.lines || []).map((line) => Number(line.itemId)).filter(Number.isInteger);
    if (req.body?.refreshInventory !== false && itemIds.length) await refreshTransferDependencyInventory(itemIds);
    const batch = await generateTransferDependencySuggestion({
      salesOrderId: req.body?.salesOrderId,
      mode: req.body?.mode,
      reservationOverrides: req.body?.reservationOverrides,
      operatorId: req.operator?.id
    });
    emitAppEvent("scm.transfer_dependency.updated", { batchId: batch.id, orderId: batch.salesOrderRef });
    res.status(201).json(batch);
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/transfer-dependencies/batches/:id", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    const batch = await updateTransferDependencyBatch(req.params.id, req.body || {}, req.operator?.id);
    emitAppEvent("scm.transfer_dependency.updated", { batchId: batch.id, orderId: batch.salesOrderRef });
    res.json(batch);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/batches/:id/proposals/merge", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    const result = await mergeTransferDependencyProposals(
      req.params.id,
      req.body || {},
      req.operator?.id
    );
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "proposals-merged",
      batchId: result.batch.id,
      orderId: result.batch.salesOrderRef,
      proposalId: result.mergedProposalId,
      sourceProposalIds: result.sourceProposalIds
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/scm/transfer-dependencies/batches/:id/proposals/:proposalId/items", async (req, res, next) => {
  try {
    res.json(await searchTransferDependencyProposalItems(
      req.params.id,
      req.params.proposalId,
      {
        search: req.query.search || "",
        limit: req.query.limit
      }
    ));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/batches/:id/proposals/:proposalId/lines", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await refreshTransferDependencyInventory([req.body?.itemId]);
    await addTransferDependencyProposalLine(
      req.params.id,
      req.params.proposalId,
      req.body || {},
      req.operator?.id
    );
    const batch = await getTransferDependencyBatch(req.params.id);
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "proposal-manual-item-added",
      batchId: batch.id,
      orderId: batch.salesOrderRef,
      proposalId: Number(req.params.proposalId),
      itemId: Number(req.body?.itemId)
    });
    return res.status(201).json(batch);
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/scm/transfer-dependencies/batches/:id/proposals/:proposalId/lines/:lineId", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    const batch = await removeTransferDependencyProposalLine(
      req.params.id,
      req.params.proposalId,
      req.params.lineId,
      req.operator?.id
    );
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "proposal-line-removed",
      batchId: batch.id,
      orderId: batch.salesOrderRef
    });
    return res.json(batch);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scm/transfer-dependencies/batches/:id/confirm", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await refreshTransferDependencyBatchSalesOrderAllocations(req.params.id);
    await refreshTransferDependencyBatchInventory(req.params.id, req.operator?.id);
    const result = await confirmTransferDependencyBatch(req.params.id, {
      operatorId: req.operator?.id,
      createTransferOrder: async ({ proposal, batch }) => {
        const request = await transferDependencyRestPayload({ proposal, batch });
        return createTransferOrderInNetSuite(request.payload, { intercompany: request.intercompany });
      },
      hydrateTransferOrder: hydrateCreatedDependencyTransferOrder,
      findTransferOrder: findCreatedDependencyTransferOrder
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-transfer-dependency", refreshOrderPool: true });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/batches/:id/proposals/:proposalId/confirm", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await refreshTransferDependencyBatchSalesOrderAllocations(req.params.id);
    await refreshTransferDependencyBatchInventory(req.params.id, req.operator?.id);
    const result = await confirmTransferDependencyBatch(req.params.id, {
      operatorId: req.operator?.id,
      proposalId: req.params.proposalId,
      createTransferOrder: async ({ proposal, batch }) => {
        const request = await transferDependencyRestPayload({ proposal, batch });
        return createTransferOrderInNetSuite(request.payload, { intercompany: request.intercompany });
      },
      hydrateTransferOrder: hydrateCreatedDependencyTransferOrder,
      findTransferOrder: findCreatedDependencyTransferOrder
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-transfer-dependency-proposal", refreshOrderPool: true });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/batches/:id/proposals/:proposalId/approve-print", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    const result = await approveAndPrintTransferDependencyProposal(req.params.id, req.params.proposalId, req.operator);
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "transfer-dependency-approve-print",
      batchId: Number(req.params.id),
      proposalId: Number(req.params.proposalId),
      printJobId: result.printJob?.id,
      printStatus: result.printJob?.status
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-transfer-dependency-approved", refreshOrderPool: true });
    res.json(result);
  } catch (error) {
    emitAppEvent("scm.transfer_dependency.updated", {
      source: "transfer-dependency-approve-print-attention",
      batchId: Number(req.params.id),
      proposalId: Number(req.params.proposalId)
    });
    next(error);
  }
});

app.post("/api/scm/transfer-dependencies/batches/:id/retry", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await refreshTransferDependencyBatchSalesOrderAllocations(req.params.id);
    await refreshTransferDependencyBatchInventory(req.params.id, req.operator?.id);
    const result = await retryTransferDependencyBatch(req.params.id, {
      operatorId: req.operator?.id,
      createTransferOrder: async ({ proposal, batch }) => {
        const request = await transferDependencyRestPayload({ proposal, batch });
        return createTransferOrderInNetSuite(request.payload, { intercompany: request.intercompany });
      },
      hydrateTransferOrder: hydrateCreatedDependencyTransferOrder,
      findTransferOrder: findCreatedDependencyTransferOrder
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-transfer-dependency-retry", refreshOrderPool: true });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/order-dependencies/:id/reconcile", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    res.json(await reconcileOrderDependency(req.params.id, req.operator?.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/schedule", async (req, res, next) => {
  try {
    const includeRestricted = canViewRestrictedScmOrders(req.operator);
    const rows = await listScmSchedule({
      search: req.query.search || "",
      status: req.query.status || "",
      method: req.query.method || "",
      kind: req.query.kind || "",
      yard: req.query.dropoffPoint || req.query.yard || "",
      brand: req.query.brand || "",
      from: req.query.from || "",
      to: req.query.to || "",
      view: req.query.view || "",
      audience: includeRestricted ? "scm" : "operations"
    });
    const canSeeDetails = operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"]);
    const preference = canSeeDetails
      ? await getScmReconciliationPreference(req.operator?.id)
      : { showDetails: false };
    const reconciled = await enrichScmScheduleWithReconciliation(rows, {
      includeDetails: canSeeDetails && preference.showDetails,
      view: req.query.view || "",
      reviewOnly: String(req.query.reconciliationStatus || "").toLowerCase() === "review"
    });
    res.json(filterRestrictedScmOrders(reconciled, { includeRestricted }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/schedule-formatting", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getScmScheduleFormatting());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/schedule-formatting", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getScmScheduleFormatting());
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/schedule-formatting", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const formatting = await updateScmScheduleFormatting(req.body || {}, req.operator?.id);
    await writeDispatchAudit({
      action: "scm.schedule-formatting.updated",
      entityType: "scm_schedule_formatting",
      entityId: "company",
      operatorId: req.operator?.id,
      operatorName: req.operator?.display_name || req.operator?.username,
      source: "scm",
      after: formatting.rules
    }).catch(() => null);
    emitAppEvent("scm.schedule-formatting.updated", {
      source: "scm-schedule-formatting",
      updatedBy: req.operator?.id || ""
    });
    res.json(formatting);
  } catch (error) {
    next(error);
  }
});

function scmStaffSchedulePreferenceSurface(value) {
  const surface = normalizeScmSchedulePreferenceSurface(value);
  if (!["scm", "dispatch"].includes(surface)) {
    throw Object.assign(new Error("This endpoint supports SCM and Dispatch schedule preferences only."), { status: 400 });
  }
  return surface;
}

app.get("/api/scm/schedule-preferences/:surface", async (req, res, next) => {
  try {
    res.json(await getScmSchedulePreference(
      req.operator?.id,
      scmStaffSchedulePreferenceSurface(req.params.surface)
    ));
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/schedule-preferences/:surface", async (req, res, next) => {
  try {
    res.json(await updateScmSchedulePreference(
      req.operator?.id,
      scmStaffSchedulePreferenceSurface(req.params.surface),
      req.body || {}
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/reconciliation/preferences", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM or Admin access is required for reconciliation details." });
    }
    res.json(await getScmReconciliationPreference(req.operator?.id));
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/reconciliation/preferences", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM or Admin access is required for reconciliation details." });
    }
    res.json(await updateScmReconciliationPreference(
      req.operator?.id,
      req.body?.showDetails ?? req.body?.show_details
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/reconciliation/runs/:id", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM or Admin access is required to view reconciliation runs." });
    }
    const runId = Number(req.params.id);
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      return res.status(400).json({ error: "A valid reconciliation run ID is required." });
    }
    res.json(await getScmReconciliationRunDetails(runId, {
      limit: req.query.limit,
      offset: req.query.offset
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/reconciliation/retry", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM or Admin access is required to retry reconciliation." });
    }
    const run = await retryScmReconciliationOrder({
      kind: req.body?.orderKind ?? req.body?.kind,
      orderId: req.body?.orderId,
      orderRef: req.body?.orderRef,
      actor: req.operator?.id,
      includeTerminalOrders: operatorHasAnyRole(req.operator, ["admin"])
    }, {
      operationalSyncRunning: anyNetSuiteSyncRunning
    });
    if (run?.status === "interrupted") {
      return res.status(409).json({
        error: run.error || "Reconciliation yielded to an operational NetSuite synchronization.",
        run
      });
    }
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-reconciliation-retry",
      orderId: req.body?.orderId || null,
      orderRef: req.body?.orderRef || "",
      orderKind: req.body?.orderKind || req.body?.kind || "",
      refreshOrderPool: true
    });
    res.json({ run });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/reconciliation/close-missing-po", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin"])) {
      return res.status(403).json({
        error: "Admin access is required to cancel a source-missing Purchase Order."
      });
    }
    const resolution = await cancelMissingScmPurchaseOrder({
      orderId: req.body?.orderId,
      orderRef: req.body?.orderRef,
      reviewCaseId: req.body?.reviewCaseId,
      expectedLastDetectedAt: req.body?.expectedLastDetectedAt,
      confirmed: req.body?.confirm === true,
      note: req.body?.note,
      actor: req.operator?.id
    }, {
      operationalSyncRunning: anyNetSuiteSyncRunning
    });
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-reconciliation-cancel-missing-po",
      orderId: resolution.sourceOrderId,
      orderRef: resolution.sourceOrderRef,
      orderKind: "PO",
      refreshOrderPool: true
    });
    res.json({ resolution });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/reconciliation/po-split-line-options", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin"])) {
      return res.status(403).json({
        error: "Admin access is required to adjust a split PO source line."
      });
    }
    res.json(await listScmPoSplitLineAdjustmentOptions({
      orderRef: req.query?.orderRef,
      orderId: req.query?.orderId
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/reconciliation/po-split-lines/:ledgerLineId/reassign", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin"])) {
      return res.status(403).json({
        error: "Admin access is required to adjust a split PO source line."
      });
    }
    const adjustment = await reassignScmPoSplitLineSource({
      ledgerLineId: req.params.ledgerLineId,
      expectedSourceLineId: req.body?.expectedSourceLineId,
      newSourceLineId: req.body?.newSourceLineId,
      note: req.body?.note,
      allowBaselineReduction: req.body?.allowBaselineReduction === true,
      expectedBaselineQty: req.body?.expectedBaselineQty,
      actor: req.operator?.id
    });
    let run = null;
    let rerunError = "";
    try {
      run = await retryScmReconciliationOrder({
        kind: "PO",
        orderId: adjustment.sourceOrderId,
        orderRef: adjustment.sourceOrderRef,
        actor: req.operator?.id,
        includeTerminalOrders: true
      }, {
        background: true,
        // The admin has explicitly confirmed this local lineage/baseline
        // mutation with an audit note. Reconcile that one family live even
        // while the company-wide initial proposal remains unapproved.
        allowInitialApply: true,
        operationalSyncRunning: anyNetSuiteSyncRunning
      });
    } catch (error) {
      rerunError = error.message;
    }
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-reconciliation-po-split-source-reassigned",
      orderId: adjustment.sourceOrderId,
      orderRef: adjustment.sourceOrderRef,
      orderKind: "PO",
      refreshOrderPool: true
    });
    res.status(202).json({
      adjustment,
      pending: true,
      run,
      ...(rerunError ? { rerunError } : {})
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/reconciliation/resolve", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin"])) {
      return res.status(403).json({ error: "Admin access is required to resolve reconciliation review." });
    }
    const resolution = await resolveScmReconciliationReview({
      kind: req.body?.orderKind ?? req.body?.kind,
      orderRef: req.body?.orderRef,
      resolution: req.body?.resolution,
      note: req.body?.note,
      allocations: req.body?.allocations,
      actor: req.operator?.id,
      actorRole: "admin"
    });
    if (resolution.rerunRequired) {
      const run = await retryScmReconciliationOrder({
        kind: resolution.orderKind,
        orderId: resolution.sourceOrderId,
        orderRef: resolution.sourceOrderRef,
        actor: req.operator?.id
      }, {
        background: true,
        operationalSyncRunning: anyNetSuiteSyncRunning
      });
      return res.status(202).json({
        resolution,
        pending: true,
        run
      });
    }
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-reconciliation-resolved",
      orderId: resolution.sourceOrderId,
      orderRef: resolution.sourceOrderRef,
      orderKind: resolution.orderKind,
      refreshOrderPool: true
    });
    res.json({ resolution, pending: false });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/purchase-orders/:ref/blanket", async (req, res, next) => {
  try {
    if (!operatorHasAnyRole(req.operator, ["admin", "scm", "scm_staff"])) {
      return res.status(403).json({ error: "SCM write access required." });
    }
    await assertScmReconciliationOrderEditable({ kind: "PO", orderRef: req.params.ref });
    const operator = req.operator || await getOperatorByToken(bearerToken(req)).catch(() => null);
    const isBlanket = req.body?.isBlanket === true || req.body?.is_blanket === true;
    const updated = await setPurchaseOrderBlanketFlag(req.params.ref, {
      isBlanket,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.purchase_order.blanket_flag_updated",
      entityType: "purchase_order",
      entityId: String(updated.netsuiteId || req.params.ref),
      orderId: updated.orderRef || req.params.ref,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm-schedule",
      after: updated,
      details: { isBlanket: updated.isBlanket }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-blanket-po",
      orderId: updated.dispatchRef || updated.orderRef,
      refreshOrderPool: true
    });
    res.json({ updated });
  } catch (error) {
    next(error);
  }
});

async function refreshedScmScheduleRow(updated = {}, operator = null) {
  const scheduleId = Number(updated.id);
  if (!Number.isSafeInteger(scheduleId) || scheduleId <= 0) return null;
  const identityResult = await query(
    `SELECT order_kind, order_ref
       FROM scm_transport_schedule
      WHERE id = $1
      LIMIT 1`,
    [scheduleId]
  );
  const identity = identityResult.rows[0];
  if (!identity?.order_ref) return null;
  const rows = await listScmScheduleForOperator({
    kind: identity.order_kind,
    exactRef: identity.order_ref
  }, operator);
  const row = rows.find((candidate) =>
    candidate.orderKind === identity.order_kind
    && String(candidate.orderRef || "").toLowerCase() === String(identity.order_ref || "").toLowerCase()
  ) || null;
  if (!row) return null;
  const canSeeDetails = operatorHasAnyRole(operator, ["admin", "scm", "scm_staff"]);
  const preference = canSeeDetails
    ? await getScmReconciliationPreference(operator?.id)
    : { showDetails: false };
  const enriched = await enrichScmScheduleWithReconciliation([row], {
    includeDetails: canSeeDetails && preference.showDetails,
    view: "",
    reviewOnly: false
  });
  const visibleRows = filterRestrictedScmOrders(enriched, {
    includeRestricted: canViewRestrictedScmOrders(operator)
  });
  return visibleRows[0] || null;
}

app.post("/api/scm/schedule", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({
      kind: req.body?.orderKind || req.body?.order_kind,
      orderRef: req.body?.orderRef || req.body?.order_ref
    });
    const updated = await updateScmScheduleEntry({
      orderKind: req.body?.orderKind || req.body?.order_kind,
      orderRef: req.body?.orderRef || req.body?.order_ref,
      patch: req.body || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule.updated",
      entityType: "scm_schedule",
      entityId: `${updated.order_kind}:${updated.order_ref}`,
      orderId: updated.order_ref,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: updated
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-schedule", orderId: updated.order_ref });
    const omitSchedule = req.query.includeSchedule === "false";
    res.json({
      updated,
      ...(omitSchedule
        ? { row: await refreshedScmScheduleRow(updated, operator) }
        : { schedule: await listScmScheduleForOperator({}, req.operator) })
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/schedule/:id", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({
      kind: req.body?.orderKind || req.body?.order_kind,
      orderRef: req.params.id
    });
    const updated = await updateScmScheduleEntry({
      orderKind: req.body?.orderKind || req.body?.order_kind,
      orderRef: req.params.id,
      patch: req.body || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule.updated",
      entityType: "scm_schedule",
      entityId: `${updated.order_kind}:${updated.order_ref}`,
      orderId: updated.order_ref,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: updated
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-schedule", orderId: updated.order_ref });
    const omitSchedule = req.query.includeSchedule === "false";
    res.json({
      updated,
      ...(omitSchedule
        ? { row: await refreshedScmScheduleRow(updated, operator) }
        : { schedule: await listScmScheduleForOperator({}, req.operator) })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/schedule-groups", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ orderRefs: req.body?.refs || [] });
    const grouped = await createScmScheduleGroup({
      refs: req.body?.refs || [],
      createdBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule_group.created",
      entityType: "scm_schedule_group",
      entityId: grouped.groupRef,
      orderId: grouped.groupRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: grouped
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-group", orderId: grouped.groupRef });
    res.json({
      grouped,
      ...(req.query.includeSchedule === "false"
        ? {}
        : { schedule: await listScmScheduleForOperator({}, req.operator) })
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/schedule-groups/:groupRef", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ orderRef: req.params.groupRef });
    const cancelled = await cancelScmScheduleGroup({
      groupRef: req.params.groupRef,
      cancelledBy: operator?.id || req.query.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule_group.cancelled",
      entityType: "scm_schedule_group",
      entityId: cancelled.groupRef,
      orderId: cancelled.groupRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.query.sessionId,
      source: "scm",
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-group-cancel", orderId: cancelled.groupRef });
    res.json({ cancelled, schedule: await listScmScheduleForOperator({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/view-presets", async (req, res, next) => {
  try {
    const presets = await listScmViewPresets();
    if (canViewRestrictedScmOrders(req.operator)) return res.json(presets);
    const allowed = new Set();
    if (operatorHasAnyRole(req.operator, ["dispatcher"])) allowed.add("dispatch");
    if (operatorHasAnyRole(req.operator, ["yard_manager"])) allowed.add("yard manager");
    return res.json(presets.filter((preset) =>
      allowed.has(String(preset.name || "").trim().toLowerCase())));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/view-presets", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const preset = await upsertScmViewPreset({
      id: req.body?.id || null,
      name: req.body?.name,
      description: req.body?.description,
      config: req.body?.config || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    res.json({ preset, presets: await listScmViewPresets() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/view-presets/:id", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const preset = await upsertScmViewPreset({
      id: req.params.id,
      name: req.body?.name,
      description: req.body?.description,
      config: req.body?.config || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    res.json({ preset, presets: await listScmViewPresets() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/vrma-options", async (_req, res, next) => {
  try {
    res.json(await getScmVrmaOptions());
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/vrma-items", async (req, res, next) => {
  try {
    res.json(await searchScmVrmaItems({
      search: req.query.search,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/vrma-orders/:id", async (req, res, next) => {
  try {
    const order = await getScmVrmaOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "VRMA order not found." });
    return res.json(order);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/scm/vrma-orders", async (req, res, next) => {
  try {
    const vrmaRef = req.body?.vrmaRef || req.body?.vrma_ref;
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const before = await getScmVrmaOrder(vrmaRef);
    const created = await createScmVrmaOrder({
      vrmaRef,
      vendor: req.body?.vendor,
      localVendor: req.body?.localVendor || req.body?.local_vendor,
      pickupLocation: req.body?.pickupLocation || req.body?.pickup_location,
      dropoffLocation: req.body?.dropoffLocation || req.body?.dropoff_location,
      status: req.body?.status,
      method: req.body?.method,
      notes: req.body?.notes,
      lines: req.body?.lines || [],
      createdBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: before ? "scm.vrma_order.updated" : "scm.vrma_order.created",
      entityType: "scm_vrma_order",
      entityId: vrmaRef,
      orderId: vrmaRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      before,
      after: created,
      details: { vrmaRef, lineCount: created?.lines?.length || 0 }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-vrma", type: "PO", orderId: vrmaRef });
    res.json({
      created,
      schedule: await listScmScheduleForOperator({ kind: "VRMA" }, req.operator)
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/vrma-orders/:id", async (req, res, next) => {
  try {
    req.body.vrmaRef = req.params.id;
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const before = await getScmVrmaOrder(req.params.id);
    const updated = await createScmVrmaOrder({
      vrmaRef: req.params.id,
      vendor: req.body?.vendor,
      localVendor: req.body?.localVendor || req.body?.local_vendor,
      pickupLocation: req.body?.pickupLocation || req.body?.pickup_location,
      dropoffLocation: req.body?.dropoffLocation || req.body?.dropoff_location,
      status: req.body?.status,
      method: req.body?.method,
      notes: req.body?.notes,
      lines: req.body?.lines || [],
      createdBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-vrma", type: "PO", orderId: req.params.id });
    await writeDispatchAudit({
      action: "scm.vrma_order.updated",
      entityType: "scm_vrma_order",
      entityId: req.params.id,
      orderId: req.params.id,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      before,
      after: updated,
      details: { vrmaRef: req.params.id, lineCount: updated?.lines?.length || 0 }
    }).catch(() => null);
    res.json({
      updated,
      schedule: await listScmScheduleForOperator({ kind: "VRMA" }, req.operator)
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/vrma-orders/:id", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const note = String(req.body?.note || "").trim();
    const result = await removeScmVrmaOrder({
      vrmaRef: req.params.id,
      note,
      actor: req.operator?.id,
      expectedUpdatedAt: req.body?.expectedUpdatedAt ?? req.body?.expected_updated_at,
      confirm: req.body?.confirm === true
    });
    if (!result.idempotent) {
      await writeDispatchAudit({
        action: "scm.vrma_order.removed",
        entityType: "scm_vrma_order",
        entityId: req.params.id,
        orderId: req.params.id,
        operatorId: req.operator?.id,
        operatorName: req.operator?.display_name || req.operator?.username,
        sessionId: req.body?.audit?.sessionId,
        source: "scm",
        before: result.before,
        after: result.after,
        details: {
          note,
          softCancelled: true,
          netSuiteUpdated: false
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-vrma-removed",
      type: "VRMA",
      orderId: req.params.id,
      refreshOrderPool: true
    });
    res.json({
      result,
      schedule: await listScmScheduleForOperator({ kind: "VRMA" }, req.operator)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/vrma-orders/:id/complete-override", requireSmartScmWriteAccess, async (req, res, next) => {
  try {
    const note = String(req.body?.note || "").trim();
    const result = await completeScmVrmaOrderOverride({
      vrmaRef: req.params.id,
      note,
      actor: req.operator?.id,
      expectedUpdatedAt: req.body?.expectedUpdatedAt ?? req.body?.expected_updated_at,
      confirm: req.body?.confirm === true,
      force: req.body?.force === true
    });
    if (!result.idempotent) {
      await writeDispatchAudit({
        action: "scm.vrma_order.completed_override",
        entityType: "scm_vrma_order",
        entityId: req.params.id,
        orderId: req.params.id,
        operatorId: req.operator?.id,
        operatorName: req.operator?.display_name || req.operator?.username,
        source: "scm",
        before: result.before,
        after: result.after,
        details: {
          note,
          loadedComplete: result.loadedComplete,
          forced: result.forced === true,
          progress: result.progress || null,
          netSuiteUpdated: false
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.orders.updated", {
      source: "scm-vrma-completed-override",
      type: "VRMA",
      orderId: req.params.id,
      refreshOrderPool: true
    });
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/scm/purchase-orders", async (req, res, next) => {
  try {
    res.json(await listScmPurchaseOrdersForResponse({
      search: req.query.search || "",
      poType: req.query.poType || "",
      dropoff: req.query.dropoff || "",
      vendor: req.query.vendor || "",
      pickupPoint: req.query.pickupPoint || ""
    }, req.operator));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/scm/purchase-order-splits", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({
      kind: "PO",
      orderRef: req.body?.sourcePoRef
    });
    const created = await createScmPurchaseOrderSplit({
      sourcePoRef: req.body?.sourcePoRef,
      newPoRef: req.body?.newPoRef,
      pickupPoint: req.body?.pickupPoint,
      destinationLocationId: req.body?.destinationLocationId,
      lines: req.body?.lines,
      createdBy: operator?.id || req.body?.audit?.sessionId || "",
      details: {
        sessionId: req.body?.audit?.sessionId || "",
        source: "dispatch-scm"
      }
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_created",
      entityType: "purchase_order",
      entityId: created.split?.splitPoRef,
      orderId: created.split?.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      after: created.split,
      details: {
        sourcePoRef: created.split?.sourcePoRef,
        splitPoRef: created.split?.splitPoRef,
        lineCount: created.lines?.length || 0
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split", type: "PO", orderId: created.split?.splitPoRef });
    res.json({ created, orders: await listScmPurchaseOrdersForResponse({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-orders/:ref/ref", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ kind: "PO", orderRef: req.params.ref });
    const updated = await updatePurchaseOrderDispatchRef({
      poRef: req.params.ref,
      newRef: req.body?.newRef,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.purchase_order_ref_updated",
      entityType: "purchase_order",
      entityId: updated.displayRef,
      orderId: updated.displayRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: { displayRef: updated.oldDisplayRef },
      after: { displayRef: updated.displayRef, dispatchRef: updated.dispatchRef },
      details: {
        poRef: updated.poRef,
        updatedPlans: updated.updatedPlans
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-ref", type: "PO", orderId: updated.displayRef });
    emitAppEvent("receiving.order.updated", { source: "scm-po-ref", type: "PO", orderId: updated.poId });
    res.json({ updated, orders: await listScmPurchaseOrdersForResponse({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-order-splits/:ref", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ kind: "PO", orderRef: req.params.ref });
    const updated = await updateScmPurchaseOrderSplitRef({
      splitPoRef: req.params.ref,
      newPoRef: req.body?.newPoRef,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_ref_updated",
      entityType: "purchase_order",
      entityId: updated.newPoRef,
      orderId: updated.newPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: { splitPoRef: updated.oldPoRef },
      after: { splitPoRef: updated.newPoRef },
      details: {
        sourcePoRef: updated.sourcePoRef,
        updatedPlans: updated.updatedPlans
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-rename", type: "PO", orderId: updated.newPoRef });
    res.json({ updated, orders: await listScmPurchaseOrdersForResponse({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-order-splits/:ref/destination", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ kind: "PO", orderRef: req.params.ref });
    const updated = await updateScmPurchaseOrderSplitDestination({
      splitPoRef: req.params.ref,
      destinationLocationId: req.body?.destinationLocationId,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_destination_updated",
      entityType: "purchase_order",
      entityId: updated.splitPoRef,
      orderId: updated.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: {
        destinationLocationId: updated.oldDestinationLocationId,
        destinationLocation: updated.oldDestinationLocation
      },
      after: {
        destinationLocationId: updated.destinationLocationId,
        destinationLocation: updated.destinationLocation
      },
      details: {
        sourcePoRef: updated.sourcePoRef
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-destination", type: "PO", orderId: updated.splitPoRef });
    emitAppEvent("receiving.order.updated", { source: "scm-po-split-destination", type: "PO", orderId: updated.splitPoId });
    res.json({ updated, orders: await listScmPurchaseOrdersForResponse({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-order-splits/:ref/pickup", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ kind: "PO", orderRef: req.params.ref });
    const updated = await updateScmPurchaseOrderSplitPickupYard({
      splitPoRef: req.params.ref,
      pickupPoint: req.body?.pickupPoint,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_pickup_updated",
      entityType: "purchase_order",
      entityId: updated.splitPoRef,
      orderId: updated.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: { pickupPoint: updated.oldPickupPoint },
      after: { pickupPoint: updated.pickupPoint, pickupAddress: updated.pickupAddress },
      details: {
        sourcePoRef: updated.sourcePoRef
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-pickup", type: "PO", orderId: updated.splitPoRef });
    emitAppEvent("receiving.order.updated", { source: "scm-po-split-pickup", type: "PO", orderId: updated.splitPoId });
    res.json({ updated, orders: await listScmPurchaseOrdersForResponse({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/scm/purchase-order-splits/:ref", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    await assertScmReconciliationOrderEditable({ kind: "PO", orderRef: req.params.ref });
    const cancelled = await cancelScmPurchaseOrderSplit({
      splitPoRef: req.params.ref,
      cancelledBy: operator?.id || req.query.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_cancelled",
      entityType: "purchase_order",
      entityId: cancelled.splitPoRef,
      orderId: cancelled.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.query.sessionId,
      source: "dispatch-scm",
      before: { splitPoRef: cancelled.splitPoRef },
      after: { status: "cancelled" },
      details: {
        sourcePoRef: cancelled.sourcePoRef,
        updatedPlans: cancelled.updatedPlans
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-cancelled", type: "PO", orderId: cancelled.splitPoRef });
    res.json({ cancelled, orders: await listScmPurchaseOrdersForResponse({}, req.operator) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/planned-assignments", async (req, res, next) => {
  try {
    res.json(await listDispatchPlannedAssignments());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders/:id/split-seed", async (req, res, next) => {
  try {
    res.json(await getNextDispatchSplitSuffix({
      originalOrderId: req.params.id,
      orderType: req.query.type
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/sync", async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    res.json({
      localOnly: true,
      skipped: true,
      reason: "NetSuite order sync is admin-only. Dispatcher refresh reads local DB.",
      orders: await listDispatchOrdersForResponse({ type })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/enrich", async (req, res, next) => {
  try {
    const enriched = await refreshDispatchEnrichment({ force: req.body?.force === true || req.query.force === "true" });
    emitAppEvent("dispatch.orders.updated", { source: "enrich", type: req.query.type ? String(req.query.type).toUpperCase() : null });
    res.json({ enriched, orders: await listDispatchOrdersForResponse({ type: req.query.type ? String(req.query.type).toUpperCase() : null }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/vendor-yards", async (req, res, next) => {
  try {
    res.json(await listDispatchVendorYards());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/parser-rules", async (req, res, next) => {
  try {
    res.json(await listDispatchParserRules());
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/parser-rules/:key", async (req, res, next) => {
  try {
    const updated = await updateDispatchParserRule(req.params.key, req.body?.value);
    if (!updated) return res.status(404).json({ error: "Parser rule not found" });
    emitAppEvent("dispatch.setup.updated", { parserRule: req.params.key });
    res.json({ updated });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/reparse-missing-delivery-time", async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
    const scope = req.body?.scope || req.query.scope || "missing";
    const result = await reparseMissingSalesOrderDispatch({
      limit: req.body?.limit || req.query.limit || 200,
      dryRun,
      scope
    });
    const allNonShipped = result.scope === "non_shipped";
    await writeDispatchAudit({
      action: dryRun
        ? (allNonShipped ? "dry_run_reparse_non_shipped_delivery_orders" : "dry_run_reparse_missing_delivery_time")
        : (allNonShipped ? "reparse_non_shipped_delivery_orders" : "reparse_missing_delivery_time"),
      entityType: "sales_orders",
      entityId: allNonShipped ? "non-shipped-sales-delivery-orders" : "missing-dispatch-parser-fields",
      source: "dispatch-setup",
      after: {
        matched: result.matched,
        updated: result.updated,
        failed: result.failed,
        resolvedTime: result.resolvedTime,
        resolvedAddress: result.resolvedAddress
      },
      details: {
        limit: result.limit,
        dryRun
      }
    });
    if (!dryRun) emitAppEvent("dispatch.orders.updated", { source: allNonShipped ? "reparse-non-shipped-delivery-orders" : "reparse-missing-delivery-time", result });
    res.json(result);
  } catch (error) {
    if (error instanceof StaleDispatchPlanSaveError) return sendStaleDispatchPlanResponse(res, error);
    next(error);
  }
});

app.get("/api/dispatch/ollama-audit", async (req, res, next) => {
  try {
    res.json(await listOllamaAudit({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/audit", async (req, res, next) => {
  try {
    res.json(await listDispatchAudit({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/audit", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const written = await writeDispatchAudit({
      ...(req.body || {}),
      operatorId: operator?.id || req.body?.operatorId,
      operatorName: operator?.display_name || operator?.username || req.body?.operatorName,
      source: req.body?.source || "dispatch"
    });
    res.json({ written });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/vendor-yards/:id", async (req, res, next) => {
  try {
    const updated = await updateDispatchVendorYard(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Vendor yard row not found" });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    emitAppEvent("dispatch.vendor_yard.updated", { id: req.params.id });
    res.json({ updated, enriched });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/vendor-yards", async (req, res, next) => {
  try {
    const updated = await upsertDispatchVendorYard(req.body || {});
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    emitAppEvent("dispatch.vendor_yard.updated", { id: updated?.id });
    res.json({ updated, enriched });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/vendor-yard", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    const updated = await setPurchaseOrderVendorYard(req.params.id, req.body?.vendorYardId);
    await writeDispatchAudit({
      action: "po_vendor_yard_updated",
      entityType: "order",
      entityId: req.params.id,
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      before: req.body?.audit?.before,
      after: updated,
      details: { vendorYardId: req.body?.vendorYardId }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, type: "PO", change: "vendor_yard", sourceSessionId: req.body?.audit?.sessionId });
    const orderResponse = await dispatchMutationOrderResponse(req, [req.params.id], { legacyType: "PO" });
    res.json({ updated, order: req.query.response === "targeted" ? orderResponse.orders[0] || null : undefined, ...orderResponse });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/details", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    const updated = await updateDispatchOrderDetails(req.params.id, req.body || {});
    await writeDispatchAudit({
      action: "dispatch_info_updated",
      entityType: "order",
      entityId: req.params.id,
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      before: req.body?.audit?.before,
      after: updated,
      details: {
        type: req.body?.type,
        sourceTable: req.body?.sourceTable,
        address: req.body?.address,
        pickupAddress: req.body?.pickupAddress,
        expectedDeliveryDate: req.body?.expectedDeliveryDate,
        windowStart: req.body?.windowStart,
        windowEnd: req.body?.windowEnd
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, change: "details", sourceSessionId: req.body?.audit?.sessionId });
    if (req.query.response === "targeted") {
      const order = (await targetedDispatchMutationOrders([req.params.id]))[0] || null;
      return res.json({ updated, order });
    }
    res.json({ updated, orders: await listDispatchOrdersForResponse() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders/:id/po-allocations", async (req, res, next) => {
  try {
    res.json(await getSalesOrderPoAllocationOptions(req.params.id, { planDate: req.query.planDate || "" }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/orders/:id/po-allocations", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req, req.body?.planDate || "");
    const allocations = Array.isArray(req.body?.lines)
      ? await createSalesOrderPoAllocations({
        dispatchTargetRef: req.params.id,
        salesOrderRef: req.params.id,
        poRef: req.body?.poRef,
        planDate: req.body?.planDate || "",
        targetSignature: req.body?.targetSignature || "",
        lines: req.body.lines,
        createdBy: req.body?.audit?.sessionId || ""
      })
      : [await createSalesOrderPoAllocation({
        dispatchTargetRef: req.params.id,
        salesOrderRef: req.params.id,
        targetLineKey: req.body?.targetLineKey,
        salesLineId: req.body?.salesLineId,
        poLineId: req.body?.poLineId,
        poRef: req.body?.poRef,
        planDate: req.body?.planDate || "",
        targetSignature: req.body?.targetSignature || "",
        quantities: req.body?.quantities || req.body || {},
        createdBy: req.body?.audit?.sessionId || ""
      })];
    await writeDispatchAudit({
      action: "so_po_allocation_created",
      entityType: "so_po_allocation",
      entityId: allocations.map((allocation) => allocation.id).join(","),
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      after: allocations,
      details: {
        salesOrderRef: req.params.id,
        poRef: req.body?.poRef || allocations[0]?.poOrderRef || "",
        allocationIds: allocations.map((allocation) => allocation.id),
        salesLineIds: allocations.map((allocation) => allocation.salesLineId),
        poLineIds: allocations.map((allocation) => allocation.poLineId)
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, change: "so_po_allocation", sourceSessionId: req.body?.audit?.sessionId });
    emitAppEvent("delivery.order.updated", { orderRef: req.params.id, change: "so_po_allocation", sourceSessionId: req.body?.audit?.sessionId });
    res.json({
      allocations,
      allocation: allocations[0] || null,
      options: await getSalesOrderPoAllocationOptions(req.params.id, { planDate: req.body?.planDate || "" }),
      ...await dispatchMutationOrderResponse(req, [req.params.id, req.body?.poRef || allocations[0]?.poOrderRef])
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/po-allocations/:allocationId", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req, req.query?.planDate || "");
    const cancelled = await cancelSalesOrderPoAllocation(req.params.allocationId, { cancelledBy: req.query.sessionId || "" });
    if (!cancelled) return res.status(404).json({ error: "Allocation not found or already cancelled." });
    await writeDispatchAudit({
      action: "so_po_allocation_cancelled",
      entityType: "so_po_allocation",
      entityId: String(cancelled.id),
      orderId: cancelled.salesOrderRef,
      sessionId: req.query.sessionId,
      after: cancelled
    }).catch(() => null);
    const targetRef = cancelled.dispatchTargetRef || cancelled.salesOrderRef;
    emitAppEvent("dispatch.orders.updated", { orderId: targetRef, change: "so_po_allocation_cancelled", sourceSessionId: req.query.sessionId });
    emitAppEvent("delivery.order.updated", { orderRef: targetRef, change: "so_po_allocation_cancelled", sourceSessionId: req.query.sessionId });
    res.json({
      cancelled,
      options: await getSalesOrderPoAllocationOptions(targetRef, { planDate: req.query.planDate || "" }),
      ...await dispatchMutationOrderResponse(req, [targetRef, cancelled.poOrderRef])
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/split-orders/unsplit", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    await assertScmReconciliationOrderEditable({
      kind: req.body?.orderType,
      orderRefs: [
        req.body?.originalOrderId,
        ...(req.body?.splitOrderIds || [])
      ]
    });
    await assertNoActiveOrderDependenciesByRefs([
      req.body?.originalOrderId,
      ...(req.body?.splitOrderIds || [])
    ], "unsplit these orders");
    const result = await deactivateUnplannedDispatchSplitOrders({
      originalOrderId: req.body?.originalOrderId,
      orderType: req.body?.orderType,
      splitOrderIds: req.body?.splitOrderIds
    });
    await writeDispatchAudit({
      action: "dispatch_split_orders_deactivated",
      entityType: "order",
      entityId: req.body?.originalOrderId || "",
      orderId: req.body?.originalOrderId || "",
      sessionId: req.body?.audit?.sessionId,
      after: result,
      details: {
        originalOrderId: req.body?.originalOrderId || "",
        orderType: req.body?.orderType || "",
        splitOrderIds: req.body?.splitOrderIds || []
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", {
      orderId: req.body?.originalOrderId || "",
      change: "order_unsplit",
      sourceSessionId: req.body?.audit?.sessionId,
      refreshOrderPool: true
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/co-orders", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    const co = await upsertLocalCoOrder({
      sourceOrderRef: req.body?.sourceOrderRef,
      fromYard: req.body?.fromYard,
      toYard: req.body?.toYard,
      order: req.body?.order || {},
      plan: {
        id: req.body?.planId,
        planDate: req.body?.planDate,
        truckPlate: req.body?.truckPlate,
        loadName: req.body?.loadName,
        parkingSpot: req.body?.parkingSpot
      },
      requestedBy: req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "co_saved_to_local_db",
      entityType: "order",
      entityId: co.co_ref,
      orderId: co.co_ref,
      sessionId: req.body?.audit?.sessionId,
      after: co,
      details: { sourceOrderRef: co.source_order_ref, fromYard: co.from_location, toYard: co.to_location }
    }).catch(() => null);
    emitAppEvent("dispatch.co.updated", { coRef: co.co_ref, sourceOrderRef: co.source_order_ref, sourceSessionId: req.body?.audit?.sessionId });
    emitAppEvent("delivery.order.updated", { orderRef: co.source_order_ref, coRef: co.co_ref, source: "dispatch-co" });
    res.json({ co });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/co-orders/:coRef", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    const cancelled = await cancelLocalCoOrder(req.params.coRef, { requestedBy: req.query.sessionId || "" });
    if (!cancelled) return res.status(409).json({ error: "CO cannot be cancelled after it is received or loaded." });
    await writeDispatchAudit({
      action: "co_cancelled_in_local_db",
      entityType: "order",
      entityId: req.params.coRef,
      orderId: req.params.coRef,
      sessionId: req.query.sessionId,
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.co.updated", { coRef: req.params.coRef, cancelled: true, sourceSessionId: req.query.sessionId });
    emitAppEvent("delivery.order.updated", { coRef: req.params.coRef, cancelled: true, source: "dispatch-co" });
    res.json({
      cancelled,
      ...await dispatchMutationOrderResponse(req, [cancelled.source_order_ref || cancelled.sourceOrderRef])
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/operator-requests", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    const written = await createDispatchOperatorRequest({
      requestType: req.body?.requestType,
      orderRef: req.body?.orderRef,
      sourceOrderType: req.body?.sourceOrderType,
      requestedBy: req.body?.requestedBy || req.body?.audit?.sessionId || "",
      details: req.body?.details || {}
    });
    await writeDispatchAudit({
      action: "operator_request_created",
      entityType: "operator_request",
      entityId: String(written.id),
      orderId: written.order_ref,
      sessionId: req.body?.audit?.sessionId,
      after: written,
      details: { requestType: written.request_type, orderRef: written.order_ref }
    }).catch(() => null);
    emitAppEvent("dispatch.operator_request.created", { requestId: written.id, requestType: written.request_type, orderRef: written.order_ref, sourceSessionId: req.body?.audit?.sessionId });
    res.json({ written });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/plan", async (req, res, next) => {
  try {
    const saveMode = dispatchPlanSaveMode(req.body);
    const requestedOrders = Array.isArray(req.body?.orders) ? req.body.orders : [];
    const requestedTrucks = Array.isArray(req.body?.trucks) ? req.body.trucks : [];
    const planDate = req.body?.planDate || req.body?.date || new Date().toISOString().slice(0, 10);
    await requireDispatchPlanEditLease(req, planDate);
    let plan = req.body?.planId ? await getDispatchPlan(req.body.planId) : await getCurrentDispatchPlan({ planDate });
    if (!plan) plan = await createDispatchPlan({ planDate });
    const previousPlan = plan;
    let cleanOrders = saveMode === "truck_sequence" && previousPlan
      ? previousPlan.orders || []
      : requestedOrders;
    let cleanTrucks = saveMode === "truck_sequence" && previousPlan
      ? mergeDispatchTruckSequence(previousPlan.trucks || [], requestedTrucks)
      : requestedTrucks;
    if (config.dispatch?.driverOrientedPlanning) {
      cleanTrucks = normalizeDispatchPlanLoadAssignments({ ...previousPlan, trucks: cleanTrucks }).trucks;
    }
    const canonicalCandidate = await canonicalizeDispatchCustomOrdersInPlan({
      ...previousPlan,
      planDate: plan.planDate || planDate,
      orders: cleanOrders,
      trucks: cleanTrucks
    }, { previousPlan });
    cleanOrders = sanitizeDispatchPlanOrders(canonicalCandidate.orders || []);
    cleanTrucks = canonicalCandidate.trucks || [];
    const scheduleCandidate = await overlayDispatchLockedLoadSchedule(previousPlan, {
      ...previousPlan,
      planDate: plan.planDate || planDate,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    cleanTrucks = scheduleCandidate.trucks || [];
    const changedScmRefs = changedDispatchScmRefs(previousPlan, {
      ...previousPlan,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    await assertScmReconciliationOrderEditable({ orderRefs: changedScmRefs });
    await assertNoRestrictedScmDispatchOrders(
      changedPlacedDispatchScmAssignmentRefs(previousPlan, {
        ...previousPlan,
        orders: cleanOrders,
        trucks: cleanTrucks
      }),
      "save this plan"
    );
    const duplicateDrivers = config.dispatch?.driverOrientedPlanning ? [] : dispatchDuplicateDriverAssignments(cleanTrucks);
    if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
    const payload = {
      savedAt: new Date().toISOString(),
      orders: cleanOrders,
      trucks: cleanTrucks
    };
    const dependencyStructureChanges = await assertNoConsolidationStructureConflict(
      previousPlan,
      { orders: payload.orders }
    );
    const explicitOperatorAlertRefs = Array.isArray(req.body?.audit?.details?.operatorAlertRefs)
      ? req.body.audit.details.operatorAlertRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
      : [];
    const refreshOrderPool = req.body?.audit?.details?.refreshOrderPool === true;
    if (
      previousPlan
      && !explicitOperatorAlertRefs.length
      && !dispatchPlanDataChanged(
        { orders: previousPlan.orders || [], trucks: previousPlan.trucks || [] },
        { orders: payload.orders, trucks: payload.trucks }
      )
    ) {
      return res.json({ ...previousPlan, operatorFlags: null, noChange: true });
    }
    const nextPlanForValidation = {
      ...previousPlan,
      planDate: plan.planDate || planDate,
      orders: payload.orders,
      trucks: payload.trucks
    };
    const assignmentConflicts = await dispatchLoadAssignmentConflicts(previousPlan, nextPlanForValidation);
    if (assignmentConflicts.length) return sendDispatchLoadAssignmentConflictResponse(res, assignmentConflicts);
    const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan || {}, {
      ...nextPlanForValidation,
      id: plan.id
    });
    if (dateConflicts.length) return sendDispatchPlanDateConflictResponse(res, dateConflicts);
    const coSequenceConflicts = await findChangedDispatchCoSequenceConflicts(previousPlan, {
      id: plan.id,
      planDate: plan.planDate || planDate,
      orders: payload.orders,
      trucks: payload.trucks
    });
    if (coSequenceConflicts.length) return sendDispatchCoSequenceConflictResponse(res, coSequenceConflicts);
    const dependencyConflicts = await validateDispatchPlanDependencies({
      id: plan.id,
      planDate: plan.planDate || planDate,
      orders: payload.orders,
      trucks: payload.trucks
    });
    if (dependencyConflicts.length) return sendDispatchDependencyConflictResponse(res, dependencyConflicts);
    const savedPlan = await saveDispatchPlanSnapshot(plan.id, {
      orders: payload.orders,
      trucks: payload.trucks,
      summary: await dispatchPlanSummaryWithSetup(req.body?.summary || {}),
      baseRevision: saveMode === "truck_sequence" ? null : req.body?.baseRevision
    });
    await syncOrderDependenciesFromDispatchPlan(savedPlan, {
      allowEstablishedUngroupTargets: dependencyStructureChanges.safeUngroupTargets
    });
    const coAssignments = await applyDispatchPlanCoAssignments(savedPlan);
    const changedOperatorRefs = [
      ...new Set([...changedDispatchOperatorRefs(previousPlan || {}, savedPlan), ...explicitOperatorAlertRefs])
    ];
    let operatorFlags = null;
    const shouldApplyOperatorFlags = savedPlan.status === "confirmed"
      && (changedOperatorRefs.length > 0 || dispatchOperatorImpactChanged(previousPlan || {}, savedPlan));
    if (shouldApplyOperatorFlags) {
      operatorFlags = await applyConfirmedDispatchPlanToDelivery(savedPlan, { forceOrderRefs: changedOperatorRefs });
    }
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dispatchPlanPath, JSON.stringify({
      savedAt: savedPlan.savedAt || payload.savedAt,
      orders: savedPlan.orders || [],
      trucks: savedPlan.trucks || []
    }, null, 2));
    if (req.body?.audit) {
      await writeDispatchAudit({
        ...req.body.audit,
        action: req.body.audit.action || "dispatch_plan_saved",
        entityType: "plan",
        entityId: String(savedPlan.id),
        planId: savedPlan.id,
        planDate: savedPlan.planDate,
        details: {
          ...(req.body.audit.details || {}),
          orderCount: (savedPlan.orders || []).length,
          truckCount: (savedPlan.trucks || []).length,
          saveMode,
          coAssignments,
          operatorFlags,
          operatorFlagsSkipped: savedPlan.status === "confirmed" && !shouldApplyOperatorFlags
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: savedPlan.id, planDate: savedPlan.planDate, savedAt: savedPlan.savedAt, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs, refreshOrderPool });
    res.json({ ...savedPlan, operatorFlags });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    if (error instanceof StaleDispatchPlanSaveError) return sendStaleDispatchPlanResponse(res, error);
    next(error);
  }
});

app.get("/delivery", (req, res) => {
  res.redirect("/operator");
});

app.get("/operator", (req, res) => {
  res.sendFile(path.join(publicDir, "operator.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(publicDir, "driver.html"));
});

app.get([
  "/control",
  "/control/returns",
  "/control/order-locks",
  "/control/item-classification",
  "/control/vendor-mapping",
  "/control/operator-warnings",
  "/control/yard-in-outbound",
  "/control/in-outbound-record",
  "/control/cycle-count-review",
  "/control/operator-load-records"
], (req, res) => {
  res.sendFile(path.join(publicDir, "control.html"));
});

app.get([
  "/admin",
  "/admin/accounts",
  "/admin/sync",
  "/admin/reconciliation",
  "/admin/photo-storage",
  "/admin/audit",
  "/admin/return-automation"
], (req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/admin/printers", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-printers.html"));
});

app.get("/admin/mbt-gates", (_req, res) => {
  res.sendFile(path.join(publicDir, "mbt-gates.html"));
});

app.get(["/sales", "/sales/returns"], (req, res) => {
  res.sendFile(path.join(publicDir, "sales.html"));
});

app.get("/sales/planning", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch.html"));
});

app.get("/sales/schedule", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-schedule.html"));
});

app.get("/sales/monitor", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-monitor.html"));
});

app.get("/sales/printing", (req, res) => {
  res.sendFile(path.join(publicDir, "sales-printing.html"));
});

app.get("/sales/in-outbound-record", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-loaded-export.html"));
});

app.get("/dispatch", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-menu.html"));
});

app.get("/dispatch/planning", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch.html"));
});

app.get("/dispatch/custom-orders", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-custom-orders.html"));
});

app.get(["/dispatch/driver-pwa", "/dispatch/offline-review"], (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-offline-review.html"));
});

app.get("/dispatch/setup", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-setup.html"));
});

app.get("/dispatch/sales-order-methods", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-sales-order-methods.html"));
});

app.get(["/dispatch/loaded-export", "/dispatch/in-outbound-record"], (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-loaded-export.html"));
});

app.get(["/dispatch/po-to-schedule", "/dispatch/POTOschedule"], (req, res) => {
  res.sendFile(path.join(publicDir, "scm-schedule.html"));
});

app.get("/dispatch/scm", (req, res) => {
  res.redirect("/scm/POsplit");
});

app.get("/scm", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-menu.html"));
});

app.get("/scm/POsplit", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-scm.html"));
});

app.get("/scm/POTOschedule", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-schedule.html"));
});

app.get("/scm/schedule-formatting", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-schedule-formatting.html"));
});

app.get("/scm/transfer-dependencies", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-transfer-dependencies.html"));
});

app.get("/scm/VRMA", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-vrma.html"));
});

app.get("/scm/smart", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-smart.html"));
});

app.get("/scm/netsuite-po", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-netsuite-po.html"));
});

app.get("/scm/vendors", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-vendors.html"));
});

app.get("/mbt", (_req, res) => {
  res.sendFile(path.join(publicDir, "mbt-home.html"));
});

app.get("/mbt/config", (_req, res) => {
  res.sendFile(path.join(publicDir, "mbt-config.html"));
});

app.get("/mbt/frontdesk", (_req, res) => {
  res.sendFile(path.join(publicDir, "mbt-frontdesk.html"));
});

app.get("/mbt/billing", (_req, res) => {
  res.sendFile(path.join(publicDir, "mbt-billing.html"));
});

app.get("/mbt/assets", (_req, res) => {
  res.sendFile(path.join(publicDir, "mbt-assets.html"));
});

app.get("/scm/printers", (req, res) => {
  res.redirect("/admin/printers");
});

app.get("/scm/route-rules", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-route-rules.html"));
});

app.get("/dispatch/dvir", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-dvir.html"));
});

app.get("/dispatch/snapshot", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-snapshot.html"));
});

app.get("/dispatch/monitor", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-monitor.html"));
});

app.get("/dispatch/statistics", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-statistics.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "MBBS Yard Server" });
});

app.get("/api/auth/bootstrap-needed", async (req, res, next) => {
  try {
    res.json({ needed: !(await hasOperators()) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/bootstrap", async (req, res, next) => {
  try {
    if (await hasOperators()) return res.status(409).json({ error: "Operator accounts already exist." });
    const operator = await createOperator({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: "admin"
    });
    await writeAudit({
      actorType: "system",
      source: "control",
      action: "operator.bootstrap_admin",
      actorOperatorId: operator.id,
      details: { username: operator.username }
    });
    res.json({ operator });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  try {
    const result = await loginOperator(username, req.body?.password);
    await writeAudit({
      actorOperatorId: result.operator.id,
      source: "auth",
      action: "operator.login",
      details: {
        username: result.operator.username,
        role: result.operator.role,
        roles: result.operator.roles,
        ip: req.ip || "",
        userAgent: req.get("user-agent") || ""
      }
    });
    res.json(result);
  } catch (error) {
    await writeAudit({
      actorType: "anonymous",
      source: "auth",
      action: "operator.login_failed",
      details: {
        username,
        ip: req.ip || "",
        userAgent: req.get("user-agent") || ""
      }
    }).catch(() => null);
    res.status(401).json({ error: error.message });
  }
});

app.get("/api/auth/me", requireOperator, (req, res) => {
  res.json({ operator: req.operator });
});

app.post("/api/auth/logout", requireOperator, async (req, res, next) => {
  try {
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "auth",
      action: "operator.logout"
    });
    await logoutToken(bearerToken(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/photo-upload/config", requireOperator, (req, res) => {
  res.json(publicPhotoUploadConfig());
});

app.get("/api/photo-upload/preview", requirePhotoPreviewViewer, async (req, res, next) => {
  try {
    const ref = String(req.query.ref || req.query.key || "");
    if (!isR2PhotoReference(ref) && !String(req.query.key || "")) {
      return res.status(400).json({ error: "R2 photo reference is required." });
    }
    await assertReturnPhotoPreviewAccess(req.photoViewer, ref || req.query.key);
    const archived = await readArchivedPhoto(ref || req.query.key);
    if (archived?.available) {
      res.setHeader("Content-Type", archived.contentType);
      res.setHeader("Content-Length", String(archived.byteSize));
      res.setHeader("ETag", `"${archived.sha256}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.send(archived.bytes);
    }
    if (archived?.found && archived.remoteDeleted) {
      return res.status(410).json({ error: "The local photo archive file is missing and the R2 copy was already removed." });
    }
    const readTicket = createPhotoReadToken({
      actor: req.photoViewer,
      key: ref || req.query.key
    });
    const response = await fetch(readTicket.objectUrl, {
      headers: { Authorization: `Bearer ${readTicket.token}` }
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text || "R2 photo preview failed." });
    }
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (["content-type", "content-length", "cache-control", "etag"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    res.setHeader("Cache-Control", "private, max-age=300");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/photo-upload/token", requireOperator, async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = createPhotoUploadToken({
      actor: {
        id: req.operator.id,
        username: req.operator.username,
        role: req.operator.role,
        roles: req.operator.roles,
        operatorId: req.operator.id
      },
      source: body.source || "operator",
      recordType: body.recordType || "operator-load-photo",
      metadata: {
        orderType: body.orderType,
        orderId: body.orderId,
        orderRef: body.orderRef,
        lineId: body.lineId,
        stopId: body.stopId,
        planId: body.planId,
        loadId: body.loadId,
        jobId: body.jobId,
        dvirType: body.dvirType
      }
    });
    res.json(token);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operator/photo-upload-token", requireOperator, async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(createPhotoUploadToken({
      actor: {
        id: req.operator.id,
        username: req.operator.username,
        role: req.operator.role,
        roles: req.operator.roles,
        operatorId: req.operator.id
      },
      source: "operator",
      recordType: body.recordType || "operator-load-photo",
      metadata: {
        orderType: body.orderType,
        orderId: body.orderId,
        orderRef: body.orderRef,
        lineId: body.lineId,
        stopId: body.stopId,
        planId: body.planId,
        loadId: body.loadId,
        jobId: body.jobId,
        dvirType: body.dvirType
      }
    }));
  } catch (error) {
    next(error);
  }
});

app.use("/api/driver", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.use("/api/driver", driverPwaVersionGate);

app.get("/api/driver/client-version", async (req, res, next) => {
  try {
    const mode = await getDriverOfflineMode();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", DRIVER_PWA_VERSION_HEADER);
    res.json({
      ...driverPwaVersionDetails(req.get(DRIVER_PWA_VERSION_HEADER)),
      offlineEnabled: mode.enabled,
      offlineModeRevision: mode.revision,
      offlineModeUpdatedAt: mode.updatedAt,
      preserveLocalEvidence: true,
      guidance: "If reopenRequired is true, do not clear browser data. Close every Driver PWA window, then reopen it to load the latest version."
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/network-health", (_req, res) => {
  res.json({ ok: true, checkedAt: new Date().toISOString() });
});

app.post("/api/driver/login", async (req, res, next) => {
  try {
    const login = String(req.body?.username || req.body?.login || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const authenticated = await authenticateDispatchDriver(login, password);
    const driver = authenticated.driver;
    if (!driver) {
      await writeAudit({
        actorType: "driver",
        source: "auth",
        action: "driver.login_failed",
        details: { login, reason: authenticated.reason || "invalid_login", ip: req.ip || "", userAgent: req.get("user-agent") || "" }
      }).catch(() => null);
      if (authenticated.reason === "password_not_configured") {
        return res.status(401).json({ error: "Password is not set for this driver. Leave password blank or update it in Dispatch Setup." });
      }
      return res.status(401).json({ error: "Invalid driver login." });
    }
    const sessionResult = await createDriverSession(login, {
      deviceId: req.get("x-mbbs-driver-device") || req.body?.deviceId || "",
      metadata: {
        ip: req.ip || "",
        userAgent: req.get("user-agent") || ""
      }
    });
    const [dayState, driverMode] = await Promise.all([
      getDriverDayState(login, {
        samsaraAccounts: samsaraAccountsForDriver(driver),
        // Day-state contains no BIN evidence snapshot; allowing the typed stop
        // internally prevents a closed execution gate from breaking login.
        allowBin: true
      }),
      getDriverOfflineMode()
    ]);
    await writeAudit({
      actorType: "driver",
      source: "auth",
      action: "driver.login",
      details: { login, ip: req.ip || "", userAgent: req.get("user-agent") || "" }
    });
    res.json({
      token: sessionResult.token,
      driver: publicDriver(driver),
      dayState,
      offlineEnabled: driverMode.enabled,
      offlineModeRevision: driverMode.revision
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/me", requireDriver, async (req, res, next) => {
  try {
    const mode = await getDriverOfflineMode();
    res.json({
      driver: publicDriver(req.driver),
      offlineEnabled: mode.enabled,
      offlineModeRevision: mode.revision
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/sync-status", requireDriver, async (req, res, next) => {
  try {
    // Telemetry identity comes only from the authenticated session plus the
    // device header. Payload fields describe state and cannot select a device.
    const deviceId = driverDeviceId(req, { required: true, allowBody: false });
    const result = await recordDriverClientSyncStatus({
      sessionId: req.driverSession.sessionId,
      driverLogin: req.driverLogin,
      deviceId,
      status: req.body || {}
    });
    emitAppEvent("driver.offline.sync-status", {
      driverLogin: req.driverLogin,
      deviceId,
      state: result.syncStatus.state,
      planDate: result.syncStatus.planDate,
      reportedAt: result.syncStatus.serverReceivedAt
    });
    res.json({ ok: true, syncStatus: result.syncStatus });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/day-plan", requireDriver, async (req, res, next) => {
  try {
    const mode = await getDriverOfflineMode();
    if (!mode.enabled) {
      return res.status(409).json({
        code: "DRIVER_OFFLINE_MODE_DISABLED",
        error: "Admin has set the Driver PWA to online-only mode. A saved offline route is not available."
      });
    }
    const deviceId = driverDeviceId(req, { required: true });
    const requestedDate = req.query.date ? normalizePlanDate(req.query.date) : "";
    const dayState = await getDriverDayState(req.driverLogin, {
      samsaraAccounts: samsaraAccountsForDriver(req.driver),
      date: requestedDate,
      allowBin: true
    });
    const planDate = requestedDate || normalizePlanDate(dayState.planDate);
    const { result: materialized } = await authorizedDriverDayJobs(req, planDate);
    if (!materialized.planId || !materialized.jobs.length) {
      return res.status(404).json({
        code: "DRIVER_PLAN_NOT_FOUND",
        error: "No confirmed route is assigned to this driver for that date."
      });
    }
    const latest = await getLatestDriverOfflineManifest(req.driverLogin, deviceId, planDate);
    const forceRefresh = String(req.query.forceRefresh || "") === "1";
    let manifest;
    if (
      !forceRefresh
      && latest?.complete
      && String(latest.planId ?? "") === String(materialized.planId)
      && Number(latest.planRevision || 0) === Number(materialized.revision || 0)
      && new Date(latest.expiresAt).getTime() > Date.now()
      && driverOfflineManifestMatchesJobs(
        latest,
        materialized.jobs,
        req.driverLogin,
        { requireComplete: true }
      )
    ) {
      const grant = await issueDriverOfflineSyncGrant(latest.manifestId, {
        driverLogin: req.driverLogin,
        deviceId
      });
      manifest = {
        ...latest,
        driver: publicDriver(req.driver),
        dayState,
        samsaraWorkflowEnabled: driverSamsaraWorkflowEnabled(req.driver),
        offlineSyncGrant: grant.token
      };
    } else {
      manifest = await persistDriverOfflineDayPlan({
        driverLogin: req.driverLogin,
        deviceId,
        planMetadata: {
          planId: materialized.planId,
          planDate: materialized.planDate,
          planRevision: materialized.revision
        },
        jobs: materialized.jobs,
        driverProfile: publicDriver(req.driver),
        dayState,
        samsaraWorkflowEnabled: driverSamsaraWorkflowEnabled(req.driver)
      });
    }
    res.json(manifest);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/photo-upload-token", requireDriverOrOfflineGrant, async (req, res, next) => {
  try {
    const body = req.body || {};
    const offlineUpload = Boolean(req.driverOfflineAuthorization || body.offlineEventUpload === true);
    if (
      req.driver
      && !offlineUpload
      && !driverSamsaraWorkflowEnabled(req.driver)
      && (
        String(body.recordType || "").toLowerCase().includes("dvir")
        || ["pre", "post"].includes(String(body.dvirType || "").toLowerCase())
      )
    ) {
      return driverSamsaraDisabledResponse(res);
    }
    const declaredBytes = Number(body.byteSize || 0);
    if (offlineUpload && (!Number.isInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > 2 * 1024 * 1024)) {
      return res.status(400).json({ error: "Offline photo size must be between 1 byte and 2 MB." });
    }
    let registeredPhoto = null;
    if (offlineUpload) {
      registeredPhoto = await authorizeOfflinePhotoUpload({
        photoId: body.photoId,
        driverLogin: req.driverLogin,
        deviceId: driverDeviceId(req, { required: true }),
        manifestId: body.manifestId,
        eventId: body.eventId,
        recordType: body.recordType,
        mimeType: body.mimeType,
        byteSize: declaredBytes,
        sha256: body.sha256
      });
    }
    res.json(createPhotoUploadToken({
      actor: {
        id: req.driverLogin,
        login: req.driverLogin,
        driverId: req.driverLogin,
        role: "driver"
      },
      source: "driver",
      recordType: registeredPhoto?.recordType || body.recordType || "driver-stop-photo",
      metadata: {
        orderType: body.orderType,
        orderId: body.orderId,
        orderRef: body.orderRef,
        lineId: body.lineId,
        stopId: body.stopId,
        planId: body.planId,
        loadId: body.loadId,
        jobId: registeredPhoto?.jobId || body.jobId,
        dvirType: registeredPhoto?.dvirType || body.dvirType,
        manifestId: body.manifestId,
        eventId: body.eventId,
        photoId: body.photoId,
        deviceId: driverDeviceId(req),
        sha256: body.sha256,
        byteSize: declaredBytes || undefined,
        mimeType: body.mimeType
      },
      options: offlineUpload
        ? { maxBytes: declaredBytes, allowedTypes: ["image/jpeg"] }
        : {}
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/offline-sync", requireDriverOrOfflineGrant, async (req, res, next) => {
  try {
    const manifestId = String(req.body?.manifestId || "");
    const deviceId = driverDeviceId(req, { required: true });
    if (req.body?.deviceId && String(req.body.deviceId).trim() !== deviceId) {
      return res.status(409).json({
        code: "DRIVER_DEVICE_MISMATCH",
        error: "The offline sync body and device header do not match."
      });
    }
    const registration = await registerDriverOfflineSync({
      driverLogin: req.driverLogin,
      deviceId,
      manifestId,
      events: Array.isArray(req.body?.events) ? req.body.events : [],
      photoReceipts: Array.isArray(req.body?.photoReceipts) ? req.body.photoReceipts : []
    });
    const photoResults = [];
    for (const photo of registration.photos || []) {
      if (photo.durableReceipt || photo.status === "durably_received") {
        photoResults.push(photo);
        continue;
      }
      try {
        const verified = await verifyDriverOfflinePhotoObject(photo, {
          id: req.driverLogin,
          login: req.driverLogin,
          role: "driver"
        });
        photoResults.push(await markDriverOfflinePhotoDurable(photo.photoId, {
          objectReference: photo.objectReference,
          ...verified
        }));
      } catch (error) {
        const errorCode = String(error?.code || "OFFLINE_PHOTO_VERIFICATION_FAILED").slice(0, 160);
        const errorMessage = String(error?.message || error || "Photo read-back verification failed.").slice(0, 2000);
        const failed = await recordDriverOfflinePhotoVerificationFailure(photo.photoId, {
          errorCode,
          errorMessage
        });
        photoResults.push({
          ...failed,
          status: "uploaded_unverified",
          durableReceipt: false,
          errorCode,
          error: errorMessage
        });
      }
    }
    const manifest = req.driverOfflineAuthorization?.manifest
      || await getDriverOfflineManifest(manifestId, {
        driverLogin: req.driverLogin,
        deviceId,
        touch: false
      });
    const queueResults = await processDriverOfflineQueue({
      driverLogin: req.driverLogin,
      planDate: manifest.planDate,
      deviceId,
      applyEvent: applyDriverOfflineEvent
    });
    const eventResults = [];
    for (const submitted of Array.isArray(req.body?.events) ? req.body.events : []) {
      const stored = await getDriverOfflineEvent(submitted.eventId);
      if (stored) eventResults.push(stored);
    }
    const summary = await getDriverOfflineSyncSummary(manifestId);
    const payload = {
      manifestId,
      receivedAt: registration.receivedAt,
      events: eventResults,
      photos: photoResults,
      ...summary
    };
    if (queueResults.some((event) => event?.foregroundExecuting)) {
      return res.status(425).json({
        ...payload,
        code: "DRIVER_FOREGROUND_ACTION_IN_PROGRESS",
        error: "The online driver action is still finishing. Synchronization will retry."
      });
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/day-state", requireDriver, async (req, res, next) => {
  try {
    res.json({
      state: await getDriverDayState(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver),
        allowBin: true
      })
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/history", requireDriver, async (req, res, next) => {
  try {
    res.json({
      records: await listDriverHistory(req.driverLogin, {
        date: req.query.date || "",
        limit: req.query.limit || 100
      })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/logout", requireDriver, async (req, res, next) => {
  try {
    await Promise.all([
      revokeDriverSession(driverToken(req)),
      revokeDriverOfflineGrants({
        driverLogin: req.driverLogin,
        deviceId: req.driverSession?.deviceId || driverDeviceId(req)
      })
    ]);
    await writeAudit({
      actorType: "driver",
      source: "auth",
      action: "driver.logout",
      details: {
        login: req.driverLogin,
        deviceId: req.driverSession?.deviceId || ""
      }
    }).catch(() => null);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/dvir", requireDriver, async (req, res, next) => {
  try {
    if (!driverSamsaraWorkflowEnabled(req.driver)) return driverSamsaraDisabledResponse(res);
    const type = req.body?.type === "post" ? "post" : "pre";
    const photoDataUrls = requiredPhotoDataUrls(req.body?.photoDataUrls, 4);
    const samsaraAccounts = samsaraAccountsForDriver(req.driver);
    const state = await getDriverDayState(req.driverLogin, { samsaraAccounts, allowBin: true });
    if (type === "post" && !state.allJobsComplete) {
      return res.status(409).json({ error: "MBBS post-trip inspection is only available after all assigned stops are complete.", state });
    }
    const foregroundDvirEvent = await requireRegisteredForegroundDvirEvidence(
      req,
      type,
      photoDataUrls
    );
    const receipt = await beginDriverForegroundAction(req, "dvir_captured", type);
    const result = await runDriverForegroundAction(receipt, async () => {
      const liveState = await getDriverDayState(req.driverLogin, { samsaraAccounts, allowBin: true });
      if (foregroundDvirEvent) {
        const lockedEvent = await getDriverOfflineEvent(foregroundDvirEvent.eventId);
        if (lockedEvent?.result?.samsaraReconciled === true) {
          return {
            state: liveState,
            samsaraError: "",
            alreadyReconciled: true,
            foregroundEventId: receipt?.eventId || "",
            pendingOnline: false,
            samsaraReconciled: true
          };
        }
        const competingOfflineReceipt = await getDriverOfflineReconciliationReceipt(
          foregroundDvirEvent.eventId
        );
        if (competingOfflineReceipt) {
          throw Object.assign(
            new Error(
              competingOfflineReceipt.status === "executing"
                ? "A Samsara inspection reconciliation is already running or has an uncertain outcome."
                : "This inspection already has a competing Samsara reconciliation receipt."
            ),
            {
              status: 409,
              code: "DRIVER_DVIR_COMPETING_RECONCILIATION",
              competingReceiptStatus: competingOfflineReceipt.status
            }
          );
        }
        if (
          lockedEvent?.status !== "applied"
          || lockedEvent.result?.pendingOnline !== true
        ) {
          throw Object.assign(
            new Error("The registered inspection event changed before its Samsara action could run."),
            { status: 409, code: "DRIVER_FOREGROUND_STATE_CONFLICT" }
          );
        }
      }
      if (
        receipt
        &&
        normalizedPlate(receipt.eventContext.truckPlate)
        !== normalizedPlate(liveState.truckPlate)
      ) {
        throw Object.assign(
          new Error("The assigned truck changed after these inspection photos were captured."),
          { status: 409, code: "DRIVER_FOREGROUND_TRUCK_CHANGED" }
        );
      }
      if (type === "post" && !liveState.allJobsComplete) {
        throw Object.assign(
          new Error("MBBS post-trip inspection is only available after all assigned stops are complete."),
          { status: 409, code: "DRIVER_POST_DVIR_TOO_EARLY" }
        );
      }
      const submitted = await submitDriverDvir(req.driverLogin, {
        type,
        photoDataUrls,
        samsaraAccounts,
        samsaraDvirAuthorId: (await readDispatchSetup()).samsara?.dvirAuthorId || config.samsara.dvirAuthorId || ""
      });
      if (receipt && submitted.samsaraError) {
        throw Object.assign(new Error(submitted.samsaraError), {
          status: 409,
          code: "DRIVER_SAMSARA_DVIR_NOT_CONFIRMED"
        });
      }
      if (foregroundDvirEvent) {
        const confirmed = type === "post"
          ? submitted.state?.samsaraPostDvirConfirmed === true
          : submitted.state?.samsaraPreDvirConfirmed === true;
        if (!confirmed) {
          throw Object.assign(new Error("Samsara did not durably confirm the inspection."), {
            status: 409,
            code: "DRIVER_SAMSARA_DVIR_NOT_CONFIRMED"
          });
        }
        const updatedEvent = await query(
          `UPDATE driver_offline_events
              SET application_result = COALESCE(application_result, '{}'::jsonb) || $2::jsonb,
                  updated_at = now()
            WHERE event_id = $1::uuid
              AND status = 'applied'
              AND event_type = 'dvir_captured'
          RETURNING event_id`,
          [
            foregroundDvirEvent.eventId,
            JSON.stringify({
              pendingOnline: false,
              interactiveSamsaraSubmissionRequired: false,
              samsaraReconciled: true,
              samsaraReconciledAt: new Date().toISOString()
            })
          ]
        );
        if (!updatedEvent.rowCount) {
          throw Object.assign(new Error("The registered inspection event changed while Samsara was being updated."), {
            status: 409,
            code: "DRIVER_FOREGROUND_STATE_CONFLICT"
          });
        }
      }
      await writeAudit({
        actorType: "driver",
        source: "samsara",
        action: type === "post" ? "driver.post_dvir.submitted" : "driver.pre_dvir.submitted",
        details: {
          driverLogin: req.driverLogin,
          samsaraUsername: submitted.samsaraUsername || "",
          samsaraAccount: submitted.samsaraAccount || "",
          truckPlate: submitted.state?.truckPlate || "",
          planDate: submitted.state?.planDate || "",
          samsaraError: submitted.samsaraError || "",
          eventId: receipt?.eventId || ""
        }
      }).catch(() => {});
      emitAppEvent("driver.dvir.submitted", {
        driverLogin: req.driverLogin,
        type,
        truckPlate: submitted.state?.truckPlate || "",
        samsaraError: submitted.samsaraError || ""
      });
      return {
        ...submitted,
        ...(receipt ? {
          foregroundEventId: receipt.eventId,
          pendingOnline: false,
          samsaraReconciled: true
        } : {})
      };
    });
    res.json(result);
  } catch (error) {
    const eventId = String(req.body?.eventId || "").trim().toLowerCase();
    if (
      eventId
      && [
        "DRIVER_FOREGROUND_OUTCOME_UNCERTAIN",
        "DRIVER_FOREGROUND_DVIR_EVIDENCE_MISMATCH"
      ].includes(String(error?.code || ""))
    ) {
      const event = await getDriverOfflineEvent(eventId).catch(() => null);
      if (
        event
        && event.eventType === "dvir_captured"
        && String(event.driverLogin).toLowerCase() === String(req.driverLogin).toLowerCase()
      ) {
        const reviewed = await markAppliedDriverOfflineReconciliationReview(
          event,
          String(error?.message || "The online Samsara inspection outcome requires review."),
          {
            code: String(error?.code || "DRIVER_FOREGROUND_OUTCOME_UNCERTAIN"),
            pendingOnline: false,
            interactiveSamsaraSubmissionRequired: false,
            reconciliationOutcomeUncertain: true
          }
        ).catch(() => null);
        if (reviewed) {
          return res.status(409).json({
            error: reviewed.error || error.message,
            code: error.code,
            reviewRequired: true,
            eventId: reviewed.eventId
          });
        }
      }
    }
    next(error);
  }
});

const DRIVER_OFFLINE_RECONCILIATION_EXECUTING_MS = 5 * 60 * 1000;

async function markAppliedDriverOfflineReconciliationReview(event, reason, result = {}) {
  await query(
    `UPDATE driver_offline_events
        SET status = 'review_required',
            review_reason = $2,
            application_result = COALESCE(application_result, '{}'::jsonb) || $3::jsonb,
            case_version = case_version + 1,
            updated_at = now()
      WHERE event_id = $1::uuid
        AND status = 'applied'`,
    [event.eventId, String(reason || "Samsara reconciliation requires review."), JSON.stringify(result || {})]
  );
  return {
    reviewRequired: true,
    eventId: event.eventId,
    error: String(reason || "Samsara reconciliation requires review.")
  };
}

async function mergeAppliedDriverOfflineReconciliationResult(eventId, result, completionMarker) {
  const updated = await query(
    `UPDATE driver_offline_events
        SET application_result = COALESCE(application_result, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE event_id = $1::uuid
        AND status = 'applied'
        AND NOT (COALESCE(application_result, '{}'::jsonb) @> $3::jsonb)
    RETURNING event_id`,
    [eventId, JSON.stringify(result || {}), JSON.stringify(completionMarker || {})]
  );
  return updated.rowCount > 0;
}

function recentExecutingDriverOfflineReconciliation(receipt) {
  return receipt?.status === "executing"
    && Date.now() - new Date(receipt.startedAt || 0).getTime()
      < DRIVER_OFFLINE_RECONCILIATION_EXECUTING_MS;
}

async function lockDriverOfflineReconciliation(event) {
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
  await query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    [String(event.driverLogin).toLowerCase(), String(event.planDate).slice(0, 10)]
  );
}

app.post("/api/driver/offline-events/:eventId/reconcile-dvir", requireDriver, async (req, res, next) => {
  try {
    if (!driverSamsaraWorkflowEnabled(req.driver)) return driverSamsaraDisabledResponse(res);
    const samsaraAccounts = samsaraAccountsForDriver(req.driver);
    const preparation = await withTransaction(async () => {
      const event = await getDriverOfflineEvent(req.params.eventId);
      if (
        !event
        || event.eventType !== "dvir_captured"
        || String(event.driverLogin).toLowerCase() !== String(req.driverLogin).toLowerCase()
      ) {
        throw Object.assign(new Error("Pending offline inspection was not found."), { status: 404 });
      }
      await lockDriverOfflineReconciliation(event);
      const lockedEvent = await getDriverOfflineEvent(req.params.eventId);
      if (lockedEvent.result?.samsaraReconciled === true) {
        return { response: {
          alreadyReconciled: true,
          state: await getDriverDayState(req.driverLogin, {
            samsaraAccounts,
            date: lockedEvent.planDate,
            allowBin: true
          }),
          reconciliation: lockedEvent.result
        } };
      }
      if (lockedEvent.status !== "applied" || lockedEvent.result?.pendingOnline !== true) {
        throw Object.assign(
          new Error("This inspection is not ready for online Samsara reconciliation."),
          { status: 409, code: "DRIVER_OFFLINE_DVIR_NOT_READY" }
        );
      }
      const dateSafety = driverOfflineReconciliationDateSafety(
        lockedEvent.planDate,
        localDateDaysAgo(0)
      );
      if (!dateSafety.allowed) {
        return {
          response: await markAppliedDriverOfflineReconciliationReview(
            lockedEvent,
            dateSafety.reason,
            {
              pendingOnline: false,
              interactiveSamsaraSubmissionRequired: false,
              reconciliationConflict: true,
              reconciliationDateBlocked: true
            }
          ),
          status: 409
        };
      }
      const [manifest, currentPlan] = await Promise.all([
        getDriverOfflineManifest(lockedEvent.manifestId, {
          driverLogin: lockedEvent.driverLogin,
          deviceId: lockedEvent.deviceId,
          touch: false
        }),
        getDriverDayJobs(req.driverLogin, { date: lockedEvent.planDate, allowBin: true })
      ]);
      const currentState = await getDriverDayState(req.driverLogin, {
        samsaraAccounts,
        date: lockedEvent.planDate,
        allowBin: true
      });
      const capturedTruckPlate = lockedEvent.details?.truckPlate
        || manifest?.dayState?.truckPlate
        || "";
      const planMatches = String(manifest?.planId ?? "") === String(currentPlan?.planId ?? "")
        && Number(manifest?.planRevision || 0) === Number(currentPlan?.revision || 0);
      const truckMatches = Boolean(capturedTruckPlate)
        && normalizedPlate(capturedTruckPlate) === normalizedPlate(currentState.truckPlate);
      if (!planMatches || !truckMatches) {
        const reason = !planMatches
          ? "The dispatch plan changed after this offline inspection was captured."
          : `The inspection was captured for ${capturedTruckPlate}, but the current assigned truck is ${currentState.truckPlate || "unknown"}.`;
        return {
          response: await markAppliedDriverOfflineReconciliationReview(
            lockedEvent,
            reason,
            {
              pendingOnline: false,
              interactiveSamsaraSubmissionRequired: false,
              reconciliationConflict: true,
              capturedTruckPlate,
              currentTruckPlate: currentState.truckPlate || "",
              currentPlanId: currentPlan.planId,
              currentPlanRevision: currentPlan.revision
            }
          ),
          status: 409
        };
      }
      const photoReferences = requiredPhotoDataUrls(
        (lockedEvent.photos || [])
          .filter((photo) => photo.durableReceipt)
          .map((photo) => photo.objectReference),
        4
      );
      const type = lockedEvent.details?.dvirType === "post" ? "post" : "pre";
      if (type === "post" && !currentState.allJobsComplete) {
        throw Object.assign(
          new Error("The saved post-trip inspection cannot be submitted until all assigned stops are complete."),
          { status: 409, code: "DRIVER_POST_DVIR_TOO_EARLY" }
        );
      }
      return {
        event: lockedEvent,
        manifest,
        currentPlan,
        currentState,
        capturedTruckPlate,
        photoReferences,
        type
      };
    });
    if (preparation.response) {
      return res.status(preparation.status || 200).json(preparation.response);
    }

    let receiptStart;
    try {
      receiptStart = await beginDriverOfflineReconciliationReceipt({
        eventId: preparation.event.eventId,
        driverLogin: preparation.event.driverLogin,
        deviceId: preparation.event.deviceId,
        actionType: "dvir",
        context: {
          manifestId: preparation.event.manifestId,
          planId: preparation.manifest.planId,
          planDate: preparation.event.planDate,
          planRevision: preparation.manifest.planRevision,
          dvirType: preparation.type,
          truckPlate: preparation.capturedTruckPlate,
          photos: (preparation.event.photos || []).map((photo) => ({
            photoId: photo.photoId,
            sha256: photo.sha256,
            objectReference: photo.objectReference
          }))
        }
      });
    } catch (error) {
      if (error?.code !== "DRIVER_OFFLINE_RECONCILIATION_IDEMPOTENCY_CONFLICT") throw error;
      const review = await markAppliedDriverOfflineReconciliationReview(
        preparation.event,
        "The saved inspection evidence no longer matches its Samsara reconciliation receipt.",
        {
          pendingOnline: false,
          interactiveSamsaraSubmissionRequired: false,
          reconciliationOutcomeUncertain: true
        }
      );
      return res.status(409).json({ ...review, code: error.code });
    }
    let result = null;
    let eventChanged = false;
    if (!receiptStart.execute) {
      if (receiptStart.receipt.status === "applied") {
        result = receiptStart.receipt.result;
      } else if (recentExecutingDriverOfflineReconciliation(receiptStart.receipt)) {
        return res.status(425).json({
          code: "DRIVER_OFFLINE_RECONCILIATION_IN_PROGRESS",
          error: "The Samsara inspection reconciliation is still running."
        });
      } else {
        if (receiptStart.receipt.status === "executing") {
          await markDriverOfflineReconciliationReceiptUncertain(
            receiptStart.receipt.receiptId,
            Object.assign(new Error("A previous Samsara inspection attempt ended without a durable outcome."), {
              code: "DRIVER_OFFLINE_RECONCILIATION_STALE_EXECUTION"
            })
          );
        }
        const review = await markAppliedDriverOfflineReconciliationReview(
          preparation.event,
          receiptStart.receipt.errorMessage
            || "A previous Samsara inspection attempt has an uncertain outcome.",
          {
            pendingOnline: false,
            interactiveSamsaraSubmissionRequired: false,
            reconciliationOutcomeUncertain: true
          }
        );
        return res.status(409).json(review);
      }
    } else {
      let attempt;
      try {
        attempt = await withTransaction(async () => {
          await lockDriverOfflineReconciliation(preparation.event);
          const finalizeReview = async (reason, reviewResult) => {
            await releaseDriverOfflineReconciliationReceipt(receiptStart.receipt.receiptId);
            return {
              reviewResponse: await markAppliedDriverOfflineReconciliationReview(
                preparation.event,
                reason,
                reviewResult
              )
            };
          };
          const lockedEvent = await getDriverOfflineEvent(preparation.event.eventId);
          if (lockedEvent?.result?.samsaraReconciled === true) {
            const alreadyResult = {
              alreadyReconciled: true,
              reconciliation: lockedEvent.result
            };
            await completeDriverOfflineReconciliationReceipt(
              receiptStart.receipt.receiptId,
              alreadyResult
            );
            return { result: alreadyResult };
          }
          const competingForegroundReceipt = await query(
            `SELECT status, error_code, error_message
               FROM driver_foreground_action_receipts
              WHERE event_id = $1::uuid
              LIMIT 1
              FOR UPDATE`,
            [preparation.event.eventId]
          );
          if (competingForegroundReceipt.rowCount) {
            const competing = competingForegroundReceipt.rows[0];
            return finalizeReview(
              competing.status === "executing"
                ? "The online Samsara inspection is still running or ended without a durable outcome."
                : competing.error_message
                  || "The online Samsara inspection has a competing durable receipt.",
              {
                pendingOnline: false,
                interactiveSamsaraSubmissionRequired: false,
                reconciliationConflict: true,
                reconciliationOutcomeUncertain: true,
                competingReceipt: "foreground",
                competingReceiptStatus: competing.status,
                competingReceiptErrorCode: competing.error_code || ""
              }
            );
          }
          if (
            lockedEvent?.status !== "applied"
            || lockedEvent.result?.pendingOnline !== true
          ) {
            return finalizeReview(
              "The offline inspection changed while Samsara reconciliation was being prepared.",
              {
                pendingOnline: false,
                interactiveSamsaraSubmissionRequired: false,
                reconciliationConflict: true
              }
            );
          }
          const dateSafety = driverOfflineReconciliationDateSafety(
            lockedEvent.planDate,
            localDateDaysAgo(0)
          );
          if (!dateSafety.allowed) {
            return finalizeReview(
              dateSafety.reason,
              {
                pendingOnline: false,
                interactiveSamsaraSubmissionRequired: false,
                reconciliationConflict: true,
                reconciliationDateBlocked: true
              }
            );
          }
          const currentPlan = await getDriverDayJobs(req.driverLogin, {
            date: lockedEvent.planDate,
            allowBin: true
          });
          const currentState = await getDriverDayState(req.driverLogin, {
            samsaraAccounts,
            date: lockedEvent.planDate,
            allowBin: true
          });
          const capturedTruckPlate = lockedEvent.details?.truckPlate
            || preparation.manifest?.dayState?.truckPlate
            || "";
          const lockedPhotoReferences = requiredPhotoDataUrls(
            (lockedEvent.photos || [])
              .filter((photo) => photo.durableReceipt)
              .map((photo) => photo.objectReference),
            4
          );
          const planMatches = String(preparation.manifest?.planId ?? "") === String(currentPlan?.planId ?? "")
            && Number(preparation.manifest?.planRevision || 0) === Number(currentPlan?.revision || 0);
          const truckMatches = Boolean(capturedTruckPlate)
            && normalizedPlate(capturedTruckPlate) === normalizedPlate(currentState.truckPlate);
          const evidenceMatches = preparation.type === (lockedEvent.details?.dvirType === "post" ? "post" : "pre")
            && normalizedPlate(capturedTruckPlate) === normalizedPlate(preparation.capturedTruckPlate)
            && JSON.stringify(lockedPhotoReferences) === JSON.stringify(preparation.photoReferences);
          if (!planMatches || !truckMatches || !evidenceMatches) {
            return finalizeReview(
              !planMatches
                ? "The dispatch plan changed before the saved inspection reached Samsara."
                : !truckMatches
                  ? "The assigned truck changed before the saved inspection reached Samsara."
                  : "The saved inspection evidence changed before it reached Samsara.",
              {
                pendingOnline: false,
                interactiveSamsaraSubmissionRequired: false,
                reconciliationConflict: true,
                capturedTruckPlate,
                currentTruckPlate: currentState.truckPlate || "",
                currentPlanId: currentPlan.planId,
                currentPlanRevision: currentPlan.revision
              }
            );
          }
          if (preparation.type === "post" && !currentState.allJobsComplete) {
            return finalizeReview(
              "The route changed before its saved post-trip inspection reached Samsara.",
              {
                pendingOnline: false,
                interactiveSamsaraSubmissionRequired: false,
                reconciliationConflict: true
              }
            );
          }
          const dvir = await submitDriverDvir(req.driverLogin, {
            type: preparation.type,
            photoDataUrls: lockedPhotoReferences,
            samsaraAccounts,
            samsaraDvirAuthorId: (await readDispatchSetup()).samsara?.dvirAuthorId || config.samsara.dvirAuthorId || ""
          });
          const confirmed = preparation.type === "post"
            ? dvir.state?.samsaraPostDvirConfirmed === true
            : dvir.state?.samsaraPreDvirConfirmed === true;
          const reconciliation = {
            pendingOnline: !confirmed,
            interactiveSamsaraSubmissionRequired: !confirmed,
            samsaraReconciled: confirmed,
            samsaraReconciledAt: confirmed ? new Date().toISOString() : null,
            samsaraLastAttemptAt: new Date().toISOString(),
            samsaraError: dvir.samsaraError || "",
            dvirType: preparation.type,
            photoCount: lockedPhotoReferences.length
          };
          const attemptResult = { ...dvir, reconciliation };
          if (!confirmed || dvir.samsaraError) {
            throw Object.assign(
              new Error(dvir.samsaraError || "Samsara did not durably confirm the inspection."),
              {
                code: "DRIVER_OFFLINE_DVIR_OUTCOME_UNCERTAIN",
                reconciliationResult: attemptResult
              }
            );
          }
          const eventChanged = await mergeAppliedDriverOfflineReconciliationResult(
            preparation.event.eventId,
            reconciliation,
            { samsaraReconciled: true }
          );
          if (!eventChanged) {
            throw Object.assign(
              new Error("The offline inspection changed while its confirmed Samsara result was being saved."),
              {
                code: "DRIVER_OFFLINE_DVIR_OUTCOME_UNCERTAIN",
                reconciliationResult: attemptResult
              }
            );
          }
          await completeDriverOfflineReconciliationReceipt(
            receiptStart.receipt.receiptId,
            attemptResult
          );
          return { result: attemptResult, eventChanged: true };
        });
      } catch (error) {
        const uncertainResult = error?.reconciliationResult || {};
        await markDriverOfflineReconciliationReceiptUncertain(
          receiptStart.receipt.receiptId,
          error,
          uncertainResult
        );
        const reconciliation = uncertainResult.reconciliation || {};
        const review = await markAppliedDriverOfflineReconciliationReview(
          preparation.event,
          "The Samsara inspection attempt did not finish cleanly and will not be replayed automatically.",
          {
            ...reconciliation,
            pendingOnline: false,
            interactiveSamsaraSubmissionRequired: false,
            reconciliationOutcomeUncertain: true,
            reconciliationError: String(error?.message || error || "")
          }
        );
        return res.status(409).json(review);
      }
      if (attempt.reviewResponse) {
        return res.status(409).json(attempt.reviewResponse);
      }
      result = attempt.result;
      eventChanged = attempt.eventChanged === true;
    }

    if (!result?.reconciliation?.samsaraReconciled) {
      const review = await markAppliedDriverOfflineReconciliationReview(
        preparation.event,
        "The stored Samsara inspection receipt is not a confirmed reconciliation.",
        {
          pendingOnline: false,
          interactiveSamsaraSubmissionRequired: false,
          reconciliationOutcomeUncertain: true
        }
      );
      return res.status(409).json(review);
    }
    const changed = eventChanged || await mergeAppliedDriverOfflineReconciliationResult(
      preparation.event.eventId,
      result.reconciliation,
      { samsaraReconciled: true }
    );
    if (changed) {
      await writeAudit({
        actorType: "driver",
        source: "samsara",
        action: preparation.type === "post"
          ? "driver.post_dvir.offline_reconciled"
          : "driver.pre_dvir.offline_reconciled",
        details: {
          driverLogin: req.driverLogin,
          eventId: preparation.event.eventId,
          planDate: preparation.event.planDate,
          truckPlate: result.state?.truckPlate || ""
        }
      }).catch(() => null);
      emitAppEvent("driver.dvir.offline_reconciled", {
        driverLogin: req.driverLogin,
        eventId: preparation.event.eventId,
        type: preparation.type
      });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/offline-events/:eventId/reconcile-duty", requireDriver, async (req, res, next) => {
  try {
    if (!driverSamsaraWorkflowEnabled(req.driver)) return driverSamsaraDisabledResponse(res);
    const samsaraAccounts = samsaraAccountsForDriver(req.driver);
    const preparation = await withTransaction(async () => {
      const event = await getDriverOfflineEvent(req.params.eventId);
      if (
        !event
        || event.eventType !== "job_started"
        || String(event.driverLogin).toLowerCase() !== String(req.driverLogin).toLowerCase()
      ) {
        throw Object.assign(new Error("Pending offline duty action was not found."), { status: 404 });
      }
      await lockDriverOfflineReconciliation(event);
      const lockedEvent = await getDriverOfflineEvent(req.params.eventId);
      if (lockedEvent.result?.samsaraDutyReconciled === true) {
        return {
          response: {
            alreadyReconciled: true,
            reconciliation: lockedEvent.result
          }
        };
      }
      if (lockedEvent.status !== "applied" || lockedEvent.result?.samsaraDutyPendingOnline !== true) {
        throw Object.assign(
          new Error("This duty action is not ready for online reconciliation."),
          { status: 409, code: "DRIVER_OFFLINE_DUTY_NOT_READY" }
        );
      }
      const dateSafety = driverOfflineReconciliationDateSafety(
        lockedEvent.planDate,
        localDateDaysAgo(0)
      );
      if (!dateSafety.allowed) {
        return {
          response: await markAppliedDriverOfflineReconciliationReview(
            lockedEvent,
            dateSafety.reason,
            {
              samsaraDutyPendingOnline: false,
              samsaraDutyReconciliationConflict: true,
              reconciliationDateBlocked: true
            }
          ),
          status: 409
        };
      }
      const currentPlan = await getDriverDayJobs(req.driverLogin, {
        date: lockedEvent.planDate,
        allowBin: true
      });
      const effectiveJobId = lockedEvent.effectiveJobId || lockedEvent.jobId;
      const currentEntry = materializeDriverOfflineJobs(
        currentPlan.jobs || [],
        req.driverLogin
      ).find((entry) => String(entry.snapshot.jobId) === String(effectiveJobId));
      const identityMatches = currentEntry
        && currentEntry.fingerprint === lockedEvent.jobFingerprint
        && currentEntry.predecessorFingerprint === lockedEvent.predecessorFingerprint;
      if (!identityMatches) {
        const reason = "The job, predecessor, driver, or truck changed before its Samsara duty action could be reconciled.";
        return {
          response: await markAppliedDriverOfflineReconciliationReview(
            lockedEvent,
            reason,
            {
              samsaraDutyPendingOnline: false,
              samsaraDutyReconciliationConflict: true,
              currentPlanId: currentPlan.planId,
              currentPlanRevision: currentPlan.revision
            }
          ),
          status: 409
        };
      }
      return {
        event: lockedEvent,
        currentPlan,
        currentEntry,
        effectiveJobId
      };
    });
    if (preparation.response) {
      return res.status(preparation.status || 200).json(preparation.response);
    }

    const job = preparation.currentEntry.snapshot;
    let receiptStart;
    try {
      receiptStart = await beginDriverOfflineReconciliationReceipt({
        eventId: preparation.event.eventId,
        driverLogin: preparation.event.driverLogin,
        deviceId: preparation.event.deviceId,
        actionType: "duty",
        context: {
          manifestId: preparation.event.manifestId,
          planDate: preparation.event.planDate,
          jobId: preparation.event.jobId,
          effectiveJobId: preparation.effectiveJobId,
          jobFingerprint: preparation.event.jobFingerprint,
          predecessorFingerprint: preparation.event.predecessorFingerprint,
          truckPlate: job.truckPlate || ""
        }
      });
    } catch (error) {
      if (error?.code !== "DRIVER_OFFLINE_RECONCILIATION_IDEMPOTENCY_CONFLICT") throw error;
      const review = await markAppliedDriverOfflineReconciliationReview(
        preparation.event,
        "The saved duty evidence no longer matches its Samsara reconciliation receipt.",
        {
          samsaraDutyPendingOnline: false,
          samsaraDutyReconciliationConflict: true,
          reconciliationOutcomeUncertain: true
        }
      );
      return res.status(409).json({ ...review, code: error.code });
    }
    let result = null;
    if (!receiptStart.execute) {
      if (receiptStart.receipt.status === "applied") {
        result = receiptStart.receipt.result;
      } else if (recentExecutingDriverOfflineReconciliation(receiptStart.receipt)) {
        return res.status(425).json({
          code: "DRIVER_OFFLINE_RECONCILIATION_IN_PROGRESS",
          error: "The Samsara duty reconciliation is still running."
        });
      } else {
        if (receiptStart.receipt.status === "executing") {
          await markDriverOfflineReconciliationReceiptUncertain(
            receiptStart.receipt.receiptId,
            Object.assign(new Error("A previous Samsara duty attempt ended without a durable outcome."), {
              code: "DRIVER_OFFLINE_RECONCILIATION_STALE_EXECUTION"
            })
          );
        }
        const review = await markAppliedDriverOfflineReconciliationReview(
          preparation.event,
          receiptStart.receipt.errorMessage
            || "A previous Samsara duty attempt has an uncertain outcome.",
          {
            samsaraDutyPendingOnline: false,
            samsaraDutyReconciliationConflict: true,
            reconciliationOutcomeUncertain: true
          }
        );
        return res.status(409).json(review);
      }
    } else {
      let attempt;
      try {
        attempt = await withTransaction(async () => {
          await lockDriverOfflineReconciliation(preparation.event);
          const finalizeReview = async (reason, reviewResult) => {
            await releaseDriverOfflineReconciliationReceipt(receiptStart.receipt.receiptId);
            return {
              reviewResponse: await markAppliedDriverOfflineReconciliationReview(
                preparation.event,
                reason,
                reviewResult
              )
            };
          };
          const lockedEvent = await getDriverOfflineEvent(preparation.event.eventId);
          if (
            lockedEvent?.status !== "applied"
            || lockedEvent.result?.samsaraDutyPendingOnline !== true
          ) {
            return finalizeReview(
              "The offline duty action changed while Samsara reconciliation was being prepared.",
              {
                samsaraDutyPendingOnline: false,
                samsaraDutyReconciliationConflict: true
              }
            );
          }
          const dateSafety = driverOfflineReconciliationDateSafety(
            lockedEvent.planDate,
            localDateDaysAgo(0)
          );
          if (!dateSafety.allowed) {
            return finalizeReview(
              dateSafety.reason,
              {
                samsaraDutyPendingOnline: false,
                samsaraDutyReconciliationConflict: true,
                reconciliationDateBlocked: true
              }
            );
          }
          const currentPlan = await getDriverDayJobs(req.driverLogin, {
            date: lockedEvent.planDate,
            allowBin: true
          });
          const effectiveJobId = lockedEvent.effectiveJobId || lockedEvent.jobId;
          const currentEntry = materializeDriverOfflineJobs(
            currentPlan.jobs || [],
            req.driverLogin
          ).find((entry) => String(entry.snapshot.jobId) === String(effectiveJobId));
          const identityMatches = currentEntry
            && currentEntry.fingerprint === lockedEvent.jobFingerprint
            && currentEntry.predecessorFingerprint === lockedEvent.predecessorFingerprint
            && normalizedPlate(currentEntry.snapshot.truckPlate)
              === normalizedPlate(job.truckPlate);
          if (!identityMatches) {
            return finalizeReview(
              "The job, predecessor, driver, or truck changed before its Samsara duty action ran.",
              {
                samsaraDutyPendingOnline: false,
                samsaraDutyReconciliationConflict: true,
                currentPlanId: currentPlan.planId,
                currentPlanRevision: currentPlan.revision
              }
            );
          }
          const handoff = await ensureDriverSamsaraDutyForJob(req.driverLogin, {
            samsaraAccounts,
            job: currentEntry.snapshot
          });
          const pendingReasons = new Set(["pre_dvir_not_complete", "no_assignment", "no_truck"]);
          const reconciled = !pendingReasons.has(String(handoff?.reason || ""));
          const reconciliation = {
            samsaraDutyPendingOnline: !reconciled,
            samsaraDutyReconciled: reconciled,
            samsaraDutyReconciledAt: reconciled ? new Date().toISOString() : null,
            samsaraDutyLastAttemptAt: new Date().toISOString(),
            samsaraDutyResult: handoff || {}
          };
          const attemptResult = { reconciliation };
          if (!reconciled) {
            await releaseDriverOfflineReconciliationReceipt(receiptStart.receipt.receiptId);
            await query(
              `UPDATE driver_offline_events
                  SET application_result = COALESCE(application_result, '{}'::jsonb) || $2::jsonb,
                      updated_at = now()
                WHERE event_id = $1::uuid
                  AND status = 'applied'`,
              [preparation.event.eventId, JSON.stringify(reconciliation)]
            );
            return { pending: true, result: attemptResult };
          }
          await completeDriverOfflineReconciliationReceipt(
            receiptStart.receipt.receiptId,
            attemptResult
          );
          return { result: attemptResult };
        });
      } catch (error) {
        const reconciliation = error?.samsaraPartialOutcome
          ? {
              samsaraDutyPendingOnline: false,
              samsaraDutyReconciled: false,
              samsaraDutyLastAttemptAt: new Date().toISOString(),
              samsaraDutyResult: error.samsaraPartialOutcome
            }
          : {};
        await markDriverOfflineReconciliationReceiptUncertain(
          receiptStart.receipt.receiptId,
          error,
          { reconciliation }
        );
        const review = await markAppliedDriverOfflineReconciliationReview(
          preparation.event,
          "The Samsara duty attempt did not finish cleanly and will not be replayed automatically.",
          {
            ...reconciliation,
            samsaraDutyPendingOnline: false,
            samsaraDutyReconciliationConflict: true,
            reconciliationOutcomeUncertain: true,
            reconciliationError: String(error?.message || error || "")
          }
        );
        return res.status(409).json(review);
      }
      if (attempt.reviewResponse) {
        return res.status(409).json(attempt.reviewResponse);
      }
      result = attempt.result;
      if (attempt.pending) {
        return res.status(409).json({
          ...result,
          error: "Complete the pending Samsara inspection/duty setup, then retry."
        });
      }
    }

    if (!result?.reconciliation?.samsaraDutyReconciled) {
      const review = await markAppliedDriverOfflineReconciliationReview(
        preparation.event,
        "The stored Samsara duty receipt is not a confirmed reconciliation.",
        {
          samsaraDutyPendingOnline: false,
          samsaraDutyReconciliationConflict: true,
          reconciliationOutcomeUncertain: true
        }
      );
      return res.status(409).json(review);
    }
    const changed = await mergeAppliedDriverOfflineReconciliationResult(
      preparation.event.eventId,
      result.reconciliation,
      { samsaraDutyReconciled: true }
    );
    if (changed) {
      await writeAudit({
        actorType: "driver",
        source: "samsara",
        action: "driver.offline_duty.reconciled",
        details: {
          driverLogin: req.driverLogin,
          eventId: preparation.event.eventId,
          jobId: preparation.effectiveJobId,
          switchedAccount: result.reconciliation.samsaraDutyResult?.switched === true,
          account: result.reconciliation.samsaraDutyResult?.account || ""
        }
      }).catch(() => null);
      emitAppEvent("driver.offline.duty_reconciled", {
        driverLogin: req.driverLogin,
        eventId: preparation.event.eventId,
        jobId: preparation.effectiveJobId
      });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/dvir/skip", requireDriver, async (req, res, next) => {
  try {
    if (!driverSamsaraWorkflowEnabled(req.driver)) return driverSamsaraDisabledResponse(res);
    const type = req.body?.type === "post" ? "post" : "pre";
    const result = await skipDriverDvirForTesting(req.driverLogin, {
      type,
      samsaraUsername: samsaraUsernameForDriver(req.driver, "primary"),
      samsaraEnabled: true
    });
    writeAudit({
      actorType: "driver",
      source: "driver-pwa",
      action: type === "post" ? "driver.post_dvir.skipped_for_testing" : "driver.pre_dvir.skipped_for_testing",
      details: {
        driverLogin: req.driverLogin,
        truckPlate: result.state?.truckPlate || "",
        planDate: result.state?.planDate || ""
      }
    }).catch(() => {});
    emitAppEvent("driver.dvir.skipped_for_testing", {
      driverLogin: req.driverLogin,
      type,
      truckPlate: result.state?.truckPlate || ""
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/samsara-auth-token", requireDriver, async (req, res, next) => {
  try {
    if (!driverSamsaraWorkflowEnabled(req.driver)) return driverSamsaraDisabledResponse(res);
    const account = req.body?.account === "secondary" ? "secondary" : "primary";
    const username = samsaraUsernameForDriver(req.driver, account);
    if (!username) return res.status(400).json({ error: `No Samsara ${account} login ID is saved for your driver profile.` });
    const result = await createSamsaraDriverAuthToken({ username });
    res.json({
      username,
      account,
      ...publicSamsaraAuthResult(result, { includeSecret: true })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/samsara-duty-status", requireDriver, async (req, res, next) => {
  try {
    if (!driverSamsaraWorkflowEnabled(req.driver)) return driverSamsaraDisabledResponse(res);
    const account = req.body?.account === "secondary" ? "secondary" : "primary";
    const username = samsaraUsernameForDriver(req.driver, account);
    if (!username) return res.status(400).json({ error: `No Samsara ${account} username is saved for your driver profile.` });
    const dutyStatus = req.body?.dutyStatus === "OFF_DUTY" ? "OFF_DUTY" : "ON_DUTY";
    const vehiclePlate = String(req.body?.vehiclePlate || "").trim();
    let assignment = null;
    if (dutyStatus === "ON_DUTY" && vehiclePlate) {
      assignment = await createSamsaraDriverVehicleAssignment({
        username,
        vehiclePlate
      });
    }
    const result = await setSamsaraDriverDutyStatus({
      username,
      dutyStatus,
      location: req.body?.location || "",
      remark: req.body?.remark || `Changed from MBBS Driver PWA${vehiclePlate ? ` with ${vehiclePlate}` : ""}`
    });
    writeAudit({
      actorType: "driver",
      source: "samsara",
      action: "samsara.duty_status.requested",
      details: {
        driverLogin: req.driverLogin,
        samsaraUsername: username,
        samsaraDriverId: result.driver.id,
        dutyStatus,
        vehiclePlate,
        assignmentResponseStatus: assignment?.responseStatus || null,
        assignmentVehicleId: assignment?.vehicle?.id || null,
        responseStatus: result.responseStatus,
        verificationError: result.clockError || "",
        currentHosClock: result.clock || null
      }
    }).catch(() => {});
    emitAppEvent("driver.samsara.duty_status", {
      driverLogin: req.driverLogin,
      samsaraUsername: username,
      samsaraDriverId: result.driver.id,
      dutyStatus
    });
    res.json({
      ok: true,
      account,
      username,
      dutyStatus,
      vehiclePlate,
      assignment: assignment ? {
        responseStatus: assignment.responseStatus,
        vehicle: {
          id: assignment.vehicle.id,
          name: assignment.vehicle.name || "",
          licensePlate: assignment.vehicle.licensePlate || vehiclePlate
        }
      } : null,
      responseStatus: result.responseStatus,
      currentHosClock: result.clock,
      verificationError: result.clockError,
      samsaraDriver: {
        id: result.driver.id,
        name: result.driver.name || "",
        username: result.driver.username || username
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/driver-job-statuses", async (req, res, next) => {
  try {
    res.json(await listDriverJobStatuses({
      planId: req.query.planId || null,
      planDate: req.query.planDate || null
    }));
  } catch (error) {
    next(error);
  }
});

async function nextJobOfflineRouteBootstrap(req, state, context) {
  const deviceId = driverDeviceId(req);
  if (!deviceId || !context?.planId || !context?.planDate || !Array.isArray(context.jobs) || !context.jobs.length) {
    return null;
  }
  let manifest = await getLatestDriverOfflineManifest(req.driverLogin, deviceId, context.planDate);
  // /next-job materializes only the actionable job for fast first paint, while
  // /day-plan materializes every job (addresses, order lines, UOM, etc.). Compare
  // the current job using that materialized snapshot but retain the raw full
  // sequence so its predecessor fingerprint remains canonical. Comparing a
  // complete manifest to context.jobs directly would falsely report every
  // materialized stop as a Dispatch edit.
  const comparisonJobs = context.job?.jobId
    ? context.jobs.map((job) =>
        String(job.jobId) === String(context.job.jobId)
          ? { ...job, ...context.job }
          : job
      )
    : context.jobs;
  const currentContentMatches = context.job?.jobId
    ? driverOfflineManifestMatchesJobs(
        manifest,
        comparisonJobs,
        req.driverLogin,
        { requireComplete: false, requiredJobId: context.job.jobId }
      )
    : manifest?.complete === true;
  const reusable = manifest
    && String(manifest.planId ?? "") === String(context.planId)
    && Number(manifest.planRevision || 0) === Number(context.revision || 0)
    && new Date(manifest.expiresAt).getTime() > Date.now()
    && currentContentMatches
    && (
      manifest.complete
      || !context.job?.jobId
      || (manifest.jobs || []).some((job) => String(job.jobId) === String(context.job.jobId))
    );
  if (reusable) {
    const grant = await issueDriverOfflineSyncGrant(manifest.manifestId, {
      driverLogin: req.driverLogin,
      deviceId
    });
    manifest = { ...manifest, offlineSyncGrant: grant.token };
  } else {
    const currentIndex = context.job?.jobId
      ? context.jobs.findIndex((job) => String(job.jobId) === String(context.job.jobId))
      : -1;
    const bootstrapJobs = currentIndex >= 0
      ? comparisonJobs.slice(Math.max(0, currentIndex - 1), currentIndex + 1)
      : context.jobs.slice(-1);
    manifest = await persistDriverOfflineBootstrap({
      driverLogin: req.driverLogin,
      deviceId,
      planMetadata: {
        planId: context.planId,
        planDate: context.planDate,
        planRevision: context.revision
      },
      // Keep first paint O(1): only the current raw job and its predecessor are
      // needed to establish the current job's true immutable route identity. The
      // complete, fully materialized route is fetched by /day-plan in background.
      jobs: bootstrapJobs,
      driverProfile: publicDriver(req.driver),
      dayState: state,
      samsaraWorkflowEnabled: driverSamsaraWorkflowEnabled(req.driver)
    });
  }
  return driverOfflineRouteBootstrap(manifest, context.job?.jobId || "");
}

app.get("/api/driver/next-job", requireDriver, async (req, res, next) => {
  try {
    const [driverMode, { state, jobContext, rest }] = await Promise.all([
      getDriverOfflineMode(),
      (async () => {
      try {
        const [state, jobContext, rest] = await Promise.all([
          getDriverDayState(req.driverLogin, {
            samsaraAccounts: samsaraAccountsForDriver(req.driver),
            allowBin: false
          }),
          getDriverNextJobContext(req.driverLogin, {
            clientVersion: driverRequestClientVersion(req),
            minimumClientVersion: DRIVER_PWA_MINIMUM_VERSION
          }),
          getActiveDriverRest(req.driverLogin)
        ]);
        return { state, jobContext, rest };
      } catch (error) {
        if (error?.code !== "MBT_DRIVER_BIN_DISABLED") throw error;
      }

      const [{ allowBin, context: jobContext }, rest] = await Promise.all([
        authorizedDriverNextJobContext(req),
        getActiveDriverRest(req.driverLogin)
      ]);
      const state = await getDriverDayState(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver),
        allowBin
      });
      return { state, jobContext, rest };
      })()
    ]);
    const job = jobContext.job;
    const routeBootstrap = await nextJobOfflineRouteBootstrap(req, state, jobContext);
    const deviceId = driverDeviceId(req);
    const pendingCompletion = job?.jobId
      && routeBootstrap?.currentJobFingerprint
      && deviceId
      ? await findOpenDriverOfflineJobCompletion({
          driverLogin: req.driverLogin,
          deviceId,
          planDate: jobContext.planDate || job.planDate,
          jobId: job.jobId,
          jobFingerprint: routeBootstrap.currentJobFingerprint,
          jobPredecessorFingerprint: routeBootstrap.predecessorFingerprint
        })
      : null;
    if (
      state.samsaraEnabled
      && state.truckPlate
      && (state.preDvirStatus !== "complete" || !state.samsaraOnDutyConfirmed || !state.samsaraPreDvirConfirmed)
    ) {
      const suffix = state.preDvirStatus === "complete"
        ? " Samsara DVIR and On Duty confirmation are required."
        : "";
      return res.status(428).json({
        error: `MBBS pre-trip inspection must be received by Samsara before assigned jobs.${suffix}`,
        state,
        job,
        pendingCompletion,
        routeBootstrap,
        offlineEnabled: driverMode.enabled,
        offlineModeRevision: driverMode.revision
      });
    }
    const restSummary = await getDriverRestSummary(req.driverLogin, {
      planDate: rest?.planDate || job?.planDate || ""
    });
    res.json({
      state,
      job,
      rest,
      restSummary,
      pendingCompletion,
      routeBootstrap,
      offlineEnabled: driverMode.enabled,
      offlineModeRevision: driverMode.revision
    });
  } catch (error) {
    next(error);
  }
});

function driverOnlineBinEventId(value) {
  const eventId = String(value || "").trim().toLowerCase();
  if (!DRIVER_FOREGROUND_EVENT_ID_PATTERN.test(eventId)) {
    throw Object.assign(new Error("A valid online BIN event ID is required."), {
      status: 400,
      code: "DRIVER_ONLINE_BIN_EVENT_ID_INVALID"
    });
  }
  return eventId;
}

function driverOnlineBinPhotos(value) {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("Online BIN photo evidence must be an array."), {
      status: 400,
      code: "DRIVER_ONLINE_BIN_PHOTOS_INVALID"
    });
  }
  return value.map((photo, index) => {
    const descriptor = {
      photoId: String(photo?.photoId || "").trim().toLowerCase(),
      ordinal: Number(photo?.ordinal ?? index),
      objectReference: String(photo?.objectReference || "").trim(),
      sha256: String(photo?.sha256 || "").trim().toLowerCase(),
      byteSize: Number(photo?.byteSize || 0),
      mimeType: String(photo?.mimeType || "image/jpeg").trim().toLowerCase()
    };
    const referenceParts = descriptor.objectReference.replace(/^r2:\/\//u, "").split("/");
    if (
      !DRIVER_FOREGROUND_EVENT_ID_PATTERN.test(descriptor.photoId)
      || !Number.isSafeInteger(descriptor.ordinal)
      || descriptor.ordinal < 0
      || referenceParts[0] !== "driver"
      || String(referenceParts[5] || "").toLowerCase() !== descriptor.photoId
    ) {
      throw Object.assign(new Error("Online BIN photo evidence is outside its upload scope."), {
        status: 409,
        code: "DRIVER_ONLINE_BIN_PHOTO_SCOPE_INVALID"
      });
    }
    return descriptor;
  });
}

async function applyDriverOnlineBinEvent(req, eventType) {
  const deviceId = driverDeviceId(req, { required: true });
  const eventId = driverOnlineBinEventId(req.body?.eventId);
  const clientSequence = Number(req.body?.clientSequence);
  if (!Number.isSafeInteger(clientSequence) || clientSequence < 1) {
    throw Object.assign(new Error("A positive online BIN client sequence is required."), {
      status: 400,
      code: "DRIVER_ONLINE_BIN_SEQUENCE_INVALID"
    });
  }
  const photos = eventType === "job_completed"
    ? driverOnlineBinPhotos(req.body?.photos)
    : [];
  const existingResult = await query(
    `SELECT source_event_id::text, manifest_id::text, client_sequence,
            event_type, driver_login, device_id, job_id,
            device_occurred_at, server_received_at
       FROM mbt_driver_bin_event_applications
      WHERE source_event_id = $1::uuid
      LIMIT 1`,
    [eventId]
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (
      String(existing.driver_login).toLowerCase() !== String(req.driverLogin).toLowerCase()
      || String(existing.device_id) !== deviceId
      || String(existing.event_type) !== eventType
      || String(existing.job_id) !== String(req.params.jobId)
      || Number(existing.client_sequence) !== clientSequence
    ) {
      throw Object.assign(new Error("This online BIN event ID was already used for another action."), {
        status: 409,
        code: "DRIVER_ONLINE_BIN_EVENT_ID_CONFLICT"
      });
    }
    const manifest = await getDriverOfflineManifest(existing.manifest_id, {
      driverLogin: req.driverLogin,
      deviceId,
      touch: false
    });
    const job = manifest?.jobs?.find(
      (candidate) => String(candidate.jobId) === String(existing.job_id)
    );
    if (!manifest || !job) {
      throw Object.assign(new Error("The durable online BIN receipt cannot be replayed safely."), {
        status: 409,
        code: "DRIVER_ONLINE_BIN_REPLAY_UNAVAILABLE"
      });
    }
    const application = await applyMbtDriverBinOfflineEvent({
      event: {
        eventId,
        eventType,
        driverLogin: req.driverLogin,
        deviceId,
        manifestId: manifest.manifestId,
        clientSequence,
        jobId: job.jobId,
        occurredAt: existing.device_occurred_at,
        receivedAt: existing.server_received_at,
        details: req.body?.details && typeof req.body.details === "object"
          ? req.body.details
          : {},
        photos
      },
      job,
      manifest,
      photoReferences: photos.map((photo) => photo.objectReference)
    });
    const next = await authorizedDriverNextJobContext(req);
    const state = await getDriverDayState(req.driverLogin, {
      samsaraAccounts: samsaraAccountsForDriver(req.driver),
      allowBin: next.allowBin
    });
    return {
      application,
      eventId,
      job: next.context.job,
      state
    };
  }
  const target = await authorizedDriverNextJobContext(req);
  const currentJob = target.context.job;
  if (!currentJob || String(currentJob.jobId) !== String(req.params.jobId)) {
    throw Object.assign(new Error("This is no longer the next assigned BIN stop. Refresh and try again."), {
      status: 409,
      code: "DRIVER_ONLINE_BIN_TARGET_CHANGED"
    });
  }
  if (!currentJob.mbt?.schemaVersion) {
    throw Object.assign(new Error("The requested stop is not a BIN Driver job."), {
      status: 409,
      code: "DRIVER_ONLINE_BIN_JOB_REQUIRED"
    });
  }

  const planDate = normalizePlanDate(target.context.planDate || currentJob.planDate);
  const [dayState, dayJobs] = await Promise.all([
    getDriverDayState(req.driverLogin, {
      samsaraAccounts: samsaraAccountsForDriver(req.driver),
      date: planDate,
      allowBin: true
    }),
    authorizedDriverDayJobs(req, planDate)
  ]);
  const manifest = await persistDriverOfflineDayPlan({
    // The action ID also owns its server-side manifest. A concurrent retry
    // therefore receives the same generation time and immutable event clock.
    manifestId: eventId,
    driverLogin: req.driverLogin,
    deviceId,
    planMetadata: {
      planId: dayJobs.result.planId,
      planDate: dayJobs.result.planDate,
      planRevision: dayJobs.result.revision
    },
    jobs: dayJobs.result.jobs,
    driverProfile: publicDriver(req.driver),
    dayState,
    samsaraWorkflowEnabled: driverSamsaraWorkflowEnabled(req.driver)
  });
  const job = manifest.jobs.find((candidate) => String(candidate.jobId) === String(currentJob.jobId));
  if (!job) {
    throw Object.assign(new Error("The current BIN stop is missing from the live route."), {
      status: 409,
      code: "DRIVER_ONLINE_BIN_MANIFEST_INVALID"
    });
  }

  for (const photo of photos) {
    await verifyDriverOfflinePhotoObject(photo, {
      id: req.driverLogin,
      login: req.driverLogin,
      role: "driver"
    });
  }
  const manifestGeneratedAt = new Date(manifest.generatedAt).getTime();
  const occurredAt = new Date(manifestGeneratedAt + 1);
  const receivedAt = new Date(Math.max(Date.now(), occurredAt.getTime()));
  const event = {
    eventId,
    eventType,
    driverLogin: req.driverLogin,
    deviceId,
    manifestId: manifest.manifestId,
    clientSequence,
    jobId: job.jobId,
    occurredAt: occurredAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    details: req.body?.details && typeof req.body.details === "object"
      ? req.body.details
      : {},
    photos
  };
  const application = await applyMbtDriverBinOfflineEvent({
    event,
    job,
    manifest,
    photoReferences: photos.map((photo) => photo.objectReference)
  });
  const next = await authorizedDriverNextJobContext(req);
  const state = await getDriverDayState(req.driverLogin, {
    samsaraAccounts: samsaraAccountsForDriver(req.driver),
    allowBin: next.allowBin
  });
  return {
    application,
    eventId,
    job: next.context.job,
    state
  };
}

app.post("/api/driver/jobs/:jobId/bin/start", requireDriver, async (req, res, next) => {
  try {
    const result = await applyDriverOnlineBinEvent(req, "job_started");
    emitAppEvent("driver.job.started", {
      driverLogin: req.driverLogin,
      jobId: req.params.jobId,
      stopType: "bin",
      source: "online"
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/bin/complete", requireDriver, async (req, res, next) => {
  try {
    const result = await applyDriverOnlineBinEvent(req, "job_completed");
    emitAppEvent("driver.job.completed", {
      driverLogin: req.driverLogin,
      jobId: req.params.jobId,
      stopType: "bin",
      nextJobId: result.job?.jobId || null,
      source: "online"
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/rest/start", requireDriver, async (req, res, next) => {
  try {
    const nextJob = await getNextDriverJob(req.driverLogin);
    const rest = await startDriverRest(req.driverLogin, { nextJob });
    const restSummary = await getDriverRestSummary(req.driverLogin, {
      planDate: rest?.planDate || nextJob?.planDate || ""
    });
    emitAppEvent("driver.rest.started", { driverLogin: req.driverLogin, restId: rest.restId, nextJobId: rest.nextJobId || null });
    res.json({ rest, job: nextJob, restSummary });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/rest/end", requireDriver, async (req, res, next) => {
  try {
    const rest = await endDriverRest(req.driverLogin);
    const job = await getNextDriverJob(req.driverLogin);
    const restSummary = await getDriverRestSummary(req.driverLogin, {
      planDate: rest?.planDate || job?.planDate || ""
    });
    emitAppEvent("driver.rest.ended", { driverLogin: req.driverLogin, restId: rest?.restId || null, nextJobId: job?.jobId || null });
    res.json({ rest, job, restSummary });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/start", requireDriver, async (req, res, next) => {
  try {
    const activeRest = await getActiveDriverRest(req.driverLogin);
    if (activeRest) return res.status(409).json({ error: "End rest time before starting the next job.", rest: activeRest });
    const jobContext = await getDriverNextJobContext(req.driverLogin);
    const job = jobContext.job;
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    if (job.stopType === "truck_switch") {
      return res.status(409).json({ error: "Confirm the truck switch with the dedicated Switch Truck action." });
    }
    if (job.stopType === "pickup" || job.stopType === "dropoff") {
      await reconcileCompletedYardTransfersForSalesOrderStart({
        salesOrderRefs: job.orderRefs || [],
        currentJob: job,
        routeJobs: jobContext.jobs || [],
        driverLogin: req.driverLogin,
        event: {
          occurredAt: req.body?.deviceOccurredAt || new Date().toISOString(),
          deviceId: driverDeviceId(req),
          clientSequence: req.body?.clientSequence ?? null
        }
      });
      const dependencyBlock = await getSalesOrderDependencyExecutionBlock(job.orderRefs || []);
      if (dependencyBlock) return res.status(409).json({ error: dependencyBlock.message, dependencyBlock });
      if (job.stopType === "pickup") {
        const directTransferRefs = (job.dependencyPickupManifests || []).map((entry) => entry.transferOrderRef).filter(Boolean);
        const directPickupBlock = await getDirectPickupDependencyExecutionBlock(directTransferRefs);
        if (directPickupBlock) return res.status(409).json({ error: directPickupBlock.message, dependencyBlock: directPickupBlock });
      }
    }
    const receipt = await beginDriverForegroundAction(req, "job_started", job.jobId);
    const response = await runDriverForegroundAction(receipt, async () => {
      const liveContext = await getDriverNextJobContext(req.driverLogin);
      const liveJob = liveContext.job;
      if (!liveJob || liveJob.jobId !== job.jobId || liveJob.stopType === "truck_switch") {
        throw Object.assign(new Error("This is no longer the next assigned job."), {
          status: 409,
          code: "DRIVER_FOREGROUND_TARGET_CHANGED"
        });
      }
      if (liveJob.stopType === "pickup" || liveJob.stopType === "dropoff") {
        await reconcileCompletedYardTransfersForSalesOrderStart({
          salesOrderRefs: liveJob.orderRefs || [],
          currentJob: liveJob,
          routeJobs: liveContext.jobs || [],
          driverLogin: req.driverLogin,
          event: {
            occurredAt: req.body?.deviceOccurredAt || new Date().toISOString(),
            deviceId: driverDeviceId(req),
            clientSequence: req.body?.clientSequence ?? null
          }
        });
        const liveDependencyBlock = await getSalesOrderDependencyExecutionBlock(
          liveJob.orderRefs || []
        );
        if (liveDependencyBlock) {
          throw Object.assign(new Error(liveDependencyBlock.message), {
            status: 409,
            code: "DRIVER_DEPENDENCY_BLOCKED"
          });
        }
        if (liveJob.stopType === "pickup") {
          const liveDirectTransferRefs = (liveJob.dependencyPickupManifests || [])
            .map((entry) => entry.transferOrderRef)
            .filter(Boolean);
          const liveDirectPickupBlock = await getDirectPickupDependencyExecutionBlock(
            liveDirectTransferRefs
          );
          if (liveDirectPickupBlock) {
            throw Object.assign(new Error(liveDirectPickupBlock.message), {
              status: 409,
              code: "DRIVER_DIRECT_PICKUP_BLOCKED"
            });
          }
        }
      }
      const samsaraHandoff = await ensureDriverSamsaraDutyForJob(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver),
        job: liveJob
      });
      const record = await startDriverJob(req.driverLogin, req.params.jobId, {
        job: liveJob,
        occurredAt: req.body?.deviceOccurredAt || null
      });
      emitAppEvent("driver.job.started", {
        driverLogin: req.driverLogin,
        jobId: req.params.jobId,
        stopType: liveJob.stopType,
        orderRefs: liveJob.orderRefs || [],
        samsaraHandoff
      });
      return {
        record,
        job: await getNextDriverJob(req.driverLogin),
        samsaraHandoff,
        ...(receipt ? { foregroundEventId: receipt.eventId } : {})
      };
    });
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/confirm-truck-switch", requireDriver, async (req, res, next) => {
  try {
    const activeRest = await getActiveDriverRest(req.driverLogin);
    if (activeRest) return res.status(409).json({ error: "End rest time before switching trucks.", rest: activeRest });
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId || job.stopType !== "truck_switch") {
      return res.status(409).json({ error: "This is no longer the next assigned truck switch. Refresh and try again." });
    }
    const receipt = await beginDriverForegroundAction(req, "truck_switched_physical", job.jobId);
    const response = await runDriverForegroundAction(receipt, async () => {
      const liveJob = await getNextDriverJob(req.driverLogin);
      if (!liveJob || liveJob.jobId !== job.jobId || liveJob.stopType !== "truck_switch") {
        throw Object.assign(new Error("This is no longer the next assigned truck switch."), {
          status: 409,
          code: "DRIVER_FOREGROUND_TARGET_CHANGED"
        });
      }
      const result = await confirmDriverTruckSwitch(req.driverLogin, liveJob, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver)
      });
      await writeDispatchAudit({
        action: "driver_truck_switch_confirmed",
        entityType: "driver_job",
        entityId: job.jobId,
        planId: job.planId,
        planDate: job.planDate,
        operatorName: req.driverLogin,
        source: "driver",
        details: {
          driverLogin: req.driverLogin,
          fromTruckPlate: job.fromTruckPlate || "",
          toTruckPlate: job.nextTruckPlate || job.truckPlate || "",
          switchYard: job.switchYard || "",
          nextLoadId: job.loadId || "",
          samsaraAccountHandoff: Boolean(result.samsaraHandoff?.switched),
          eventId: receipt?.eventId || ""
        }
      }).catch(() => null);
      let nextJob = await getNextDriverJob(req.driverLogin);
      if (!receipt && nextJob && nextJob.stopType !== "truck_switch") {
        await startDriverJob(req.driverLogin, nextJob.jobId, { job: nextJob });
        nextJob = await getNextDriverJob(req.driverLogin);
      }
      const state = await getDriverDayState(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver),
        allowBin: true
      });
      emitAppEvent("driver.truck.switched", {
        driverLogin: req.driverLogin,
        jobId: job.jobId,
        fromTruckPlate: job.fromTruckPlate,
        truckPlate: job.nextTruckPlate || job.truckPlate,
        nextLoadId: job.loadId
      });
      return {
        ...result,
        job: nextJob,
        state,
        ...(receipt ? { foregroundEventId: receipt.eventId } : {})
      };
    });
    res.json(response);
  } catch (error) {
    await writeDispatchAudit({
      action: "driver_truck_switch_failed",
      entityType: "driver_job",
      entityId: req.params.jobId,
      operatorName: req.driverLogin,
      source: "driver",
      details: { driverLogin: req.driverLogin, error: error.message }
    }).catch(() => null);
    emitAppEvent("driver.truck.switch.attention", { driverLogin: req.driverLogin, jobId: req.params.jobId, error: error.message });
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/skip-samsara", requireDriver, async (req, res, next) => {
  try {
    const activeRest = await getActiveDriverRest(req.driverLogin);
    if (activeRest) return res.status(409).json({ error: "End rest time before switching trucks.", rest: activeRest });
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId || job.stopType !== "truck_switch") {
      return res.status(409).json({ error: "This is no longer the next assigned truck switch. Refresh and try again." });
    }
    const samsaraEnabled = driverSamsaraWorkflowEnabled(req.driver);
    const reason = samsaraEnabled
      ? "Driver skipped Samsara truck assignment."
      : "Samsara is disabled for this driver; truck switch completed locally.";
    const receipt = await beginDriverForegroundAction(req, "truck_switched_samsara_skipped", job.jobId);
    const response = await runDriverForegroundAction(receipt, async () => {
      const liveJob = await getNextDriverJob(req.driverLogin);
      if (!liveJob || liveJob.jobId !== job.jobId || liveJob.stopType !== "truck_switch") {
        throw Object.assign(new Error("This is no longer the next assigned truck switch."), {
          status: 409,
          code: "DRIVER_FOREGROUND_TARGET_CHANGED"
        });
      }
      const result = samsaraEnabled
        ? await skipDriverTruckSwitchSamsara(liveJob.jobId, req.driverLogin, { reason, job: liveJob })
        : await confirmDriverTruckSwitch(req.driverLogin, liveJob, {
            samsaraAccounts: samsaraAccountsForDriver(req.driver)
          });
      await writeDispatchAudit({
        action: samsaraEnabled
          ? "driver_truck_switch_samsara_skipped"
          : "driver_truck_switch_confirmed_samsara_disabled",
        entityType: "driver_job",
        entityId: job.jobId,
        planId: job.planId,
        planDate: job.planDate,
        operatorName: req.driverLogin,
        source: "driver",
        details: {
          driverLogin: req.driverLogin,
          fromTruckPlate: job.fromTruckPlate || "",
          toTruckPlate: job.nextTruckPlate || job.truckPlate || "",
          switchYard: job.switchYard || "",
          nextLoadId: job.loadId || "",
          samsaraError: result.switchRecord?.samsara_error || "",
          reason,
          eventId: receipt?.eventId || ""
        }
      }).catch(() => null);
      let nextJob = await getNextDriverJob(req.driverLogin);
      if (!receipt && nextJob && nextJob.stopType !== "truck_switch") {
        await startDriverJob(req.driverLogin, nextJob.jobId, { job: nextJob });
        nextJob = await getNextDriverJob(req.driverLogin);
      }
      const state = await getDriverDayState(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver),
        allowBin: true
      });
      emitAppEvent("driver.truck.switch.samsara_skipped", {
        driverLogin: req.driverLogin,
        jobId: job.jobId,
        fromTruckPlate: job.fromTruckPlate || "",
        truckPlate: job.nextTruckPlate || job.truckPlate || "",
        nextLoadId: job.loadId || ""
      });
      return {
        ...result,
        job: nextJob,
        state,
        ...(receipt ? { foregroundEventId: receipt.eventId } : {})
      };
    });
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/driver-truck-switches/attention", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json(await listDriverTruckSwitchAttention({ planId: req.query.planId || null }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/driver-truck-switches/:jobId/override", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const result = await overrideDriverTruckSwitch(req.params.jobId, {
      actor: req.operator?.login || req.operator?.username || req.operator?.name || "dispatcher",
      reason: req.body?.reason || "Dispatcher override"
    });
    await writeDispatchAudit({
      action: "dispatch_driver_truck_switch_overridden",
      entityType: "driver_job",
      entityId: req.params.jobId,
      actorType: "operator",
      actorId: req.operator?.id,
      details: { reason: req.body?.reason || "Dispatcher override", switchRecord: result.switchRecord }
    }).catch(() => null);
    emitAppEvent("driver.truck.switch.overridden", { jobId: req.params.jobId, driverLogin: result.switchRecord?.driver_login || "" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/location-check", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    const locationCheck = await checkDriverJobLocation(job);
    const verification = await createDriverLocationVerification({
      driverLogin: req.driverLogin,
      deviceId: driverDeviceId(req) || req.driverSession?.deviceId || "",
      jobId: job.jobId,
      status: locationCheck.status === "ok"
        ? "verified"
        : locationCheck.status === "warning"
          ? "warning"
          : "override_allowed",
      source: "samsara",
      details: locationCheck,
      ttlSeconds: 300
    });
    res.json({ ...locationCheck, verificationId: verification.verificationId, expiresAt: verification.expiresAt });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/photos", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    if (job.status !== "in_progress" || !job.startedAt) return res.status(409).json({ error: "Start this job before confirming it." });
    const photoDataUrls = requiredPhotoDataUrls(
      req.body?.photoDataUrls,
      Number(job.requiredPhotos || 0) > 0 ? Math.max(2, Number(job.requiredPhotos)) : 0
    );
    const secondsSinceStart = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
    if (!Number.isFinite(secondsSinceStart) || secondsSinceStart < 10) {
      return res.status(409).json({ error: "Please wait 10 seconds after starting the job before confirming it." });
    }
    const locationCheck = await checkDriverJobLocation(job);
    if (locationCheck.status !== "ok" && !req.body?.locationOverride) {
      return res.status(409).json({
        error: locationCheck.status === "warning"
          ? "Samsara truck location does not match the expected stop. Recheck or confirm override."
          : "Samsara truck location could not be verified. Recheck or confirm override.",
        locationCheck
      });
    }
    const completion = await completeDriverJobOperationalEffects({
      driverLogin: req.driverLogin,
      job,
      photoDataUrls,
      driverRemark: req.body?.driverRemark
    });
    const { record, dependencyUpdate, completedCustomOrders } = completion;
    let nextJob = await getNextDriverJob(req.driverLogin);
    let rest = null;
    if (nextJob && req.body?.autoStartRest === true) {
      rest = await startDriverRest(req.driverLogin, { nextJob });
      emitAppEvent("driver.rest.started", { driverLogin: req.driverLogin, restId: rest.restId, nextJobId: rest.nextJobId || null });
    } else if (nextJob && nextJob.stopType !== "truck_switch" && req.body?.autoStartNext !== false) {
      await ensureDriverSamsaraDutyForJob(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver),
        job: nextJob
      });
      await startDriverJob(req.driverLogin, nextJob.jobId, { job: nextJob });
      nextJob = await getNextDriverJob(req.driverLogin);
    }
    emitAppEvent("driver.job.completed", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, nextJobId: nextJob?.jobId || null, dependencyUpdate });
    if (dependencyUpdate && (Array.isArray(dependencyUpdate) ? dependencyUpdate.length : dependencyUpdate.completed?.length)) {
      emitAppEvent("dispatch.orders.updated", { source: "driver-order-dependency", refreshOrderPool: true });
    }
    if (completedCustomOrders.length) {
      emitAppEvent("dispatch.orders.updated", {
        source: "driver-custom-order",
        change: "custom_order_completed",
        orderIds: completedCustomOrders.map((order) => order.refNumber),
        refreshOrderPool: true
      });
    }
    const restSummary = await getDriverRestSummary(req.driverLogin, {
      planDate: rest?.planDate || nextJob?.planDate || job?.planDate || ""
    });
    res.json({ record, nextJob, rest, restSummary, locationCheck, dependencyUpdate, completedCustomOrders });
  } catch (error) {
    next(error);
  }
});

app.get("/api/operators", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listOperators());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/public-sales", requireOperator, requireAdmin, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getSalesPortalSettings({ fresh: true }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/public-sales", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const settings = await updateSalesPortalSettings({ enabled: req.body?.enabled }, req.operator.id);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "admin",
      action: "sales.public_access_update",
      details: { enabled: settings.enabled }
    });
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await createOperator({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: req.body?.role || "operator",
      roles: req.body?.roles,
      yardLocationIds: req.body?.yardLocationIds
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.create",
      details: { operatorId: operator.id, username: operator.username, role: operator.role, roles: operator.roles, yardLocationIds: operator.yardLocationIds }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators/:id/active", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await setOperatorActive(req.params.id, req.body?.active);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.set_active",
      details: { operatorId: req.params.id, active: Boolean(req.body?.active) }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators/:id/password", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await updateOperatorPassword(req.params.id, req.body?.password);
    if (!operator) return res.status(404).json({ error: "Operator not found" });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.password_reset",
      details: { operatorId: req.params.id, username: operator.username }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.put("/api/operators/:id/roles", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await updateOperatorRoles(req.params.id, {
      role: req.body?.role,
      roles: req.body?.roles,
      yardLocationIds: req.body?.yardLocationIds
    });
    if (!operator) return res.status(404).json({ error: "Operator not found" });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.roles_update",
      details: {
        operatorId: operator.id,
        username: operator.username,
        role: operator.role,
        roles: operator.roles,
        yardLocationIds: operator.yardLocationIds
      }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

// Return workflow operator endpoints. These routes intentionally use explicit
// staff middleware because /api/returns has no broader role middleware.
app.get("/api/returns/reasons", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const [reasons, settings] = await Promise.all([
      getReturnReasons({ refresh: req.query.refresh === "true" }),
      listReturnYardSettings()
    ]);
    res.json({
      ...reasons,
      yardSettings: settings.map((setting) => ({
        locationId: setting.locationId,
        yardCode: setting.yardCode,
        allowCrossYardReturns: setting.allowCrossYardReturns
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/orders/lookup", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    assertReturnOperatorYard(req.operator, req.body?.receivingLocationId || req.body?.yardLocationId);
    const returnMode = String(req.body?.mode || req.body?.returnMode || "").trim().toLowerCase();
    res.setHeader("Cache-Control", "no-store");
    res.json(operatorSafeReturnPayload(await lookupReturnSalesOrder({
      code: req.body?.code || req.body?.orderCode || req.body?.orderId,
      receivingLocationId: req.body?.receivingLocationId || req.body?.yardLocationId,
      includeStockReturns: returnMode !== "pallet",
      includeNetSuiteOrderLines: false,
      enforceYardRestriction: returnMode !== "pallet"
    })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/customers", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      customers: await searchReturnCustomers(req.query.search, { limit: req.query.limit })
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/customers/:customerId/pallet-balance", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const result = await lookupReturnCustomerPalletBalance(req.params.customerId);
    res.json(operatorSafeReturnPayload({ customer: result.customer, balance: result }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/operator/drafts", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    assertReturnOperatorYard(req.operator, req.query.receivingLocationId || req.query.yardLocationId);
    res.json(operatorSafeReturnPayload({
      drafts: await listReturnDrafts({
        operatorId: req.operator.id,
        receivingLocationId: req.query.receivingLocationId || req.query.yardLocationId
      })
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/operator/history", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    const result = await listReturnRecords(returnListFilters(req, {
      operatorId: req.operator.id
    }));
    const safe = operatorSafeReturnPayload(result);
    res.json({ ...safe, returns: safe.records });
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/operator/history/:id", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    const record = await getReturnRecordDetail(req.params.id, { operatorId: req.operator.id });
    if (!record) return res.status(404).json({ error: "Return record was not found." });
    res.json(operatorSafeReturnPayload(record));
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/drafts", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    assertReturnOperatorYard(req.operator, req.body?.receivingLocationId || req.body?.yardLocationId);
    res.json(operatorSafeReturnPayload({
      draft: await saveReturnDraft({ operatorId: req.operator.id, input: req.body || {} })
    }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/returns/drafts/:draftId", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    const result = await deleteReturnDraft({
      draftId: req.params.draftId,
      operatorId: req.operator.id
    });
    if (!result.deleted) return res.status(404).json({ error: "Return draft was not found." });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/submit", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    assertReturnOperatorYard(req.operator, req.body?.receivingLocationId || req.body?.yardLocationId);
    const result = await submitReturnBatch({
      operatorId: req.operator.id,
      input: req.body || {}
    });
    emitAppEvent("returns.updated", {
      source: "operator-submit",
      batchReference: result.batchReference,
      recordIds: result.records?.map((record) => record.id) || []
    });
    res.status(result.idempotentReplay ? 200 : 201).json(operatorSafeReturnPayload(result));
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/return-settings", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const allowed = returnControlYardLocationIds(req.operator);
    const settings = await listReturnYardSettings();
    res.json({ settings: allowed ? settings.filter((item) => allowed.includes(item.locationId)) : settings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/return-settings/:locationId", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    assertReturnControlYard(req.operator, req.params.locationId);
    res.json(await getReturnYardSettings(req.params.locationId));
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/return-settings/:locationId", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateReturnYardSettings(req.params.locationId, {
      allowCrossYardReturns: req.body?.allowCrossYardReturns
    }, {
      operatorId: req.operator.id,
      allowCrossYard: true,
      allowAutomation: false
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/return-settings", requireOperator, requireAdmin, async (_req, res, next) => {
  try {
    res.json({ settings: await listReturnYardSettings() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/return-settings/:locationId", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateReturnYardSettings(req.params.locationId, {
      ...(Object.hasOwn(req.body || {}, "allowCrossYardReturns")
        ? { allowCrossYardReturns: req.body.allowCrossYardReturns }
        : {}),
      ...(Object.hasOwn(req.body || {}, "autoCreateStockRa")
        ? { autoCreateStockRa: req.body.autoCreateStockRa }
        : Object.hasOwn(req.body || {}, "autoCreateStockReturnAuthorizations")
          ? { autoCreateStockRa: req.body.autoCreateStockReturnAuthorizations }
          : {}),
      ...(Object.hasOwn(req.body || {}, "autoCreatePalletCreditMemo")
        ? { autoCreatePalletCreditMemo: req.body.autoCreatePalletCreditMemo }
        : Object.hasOwn(req.body || {}, "autoCreatePalletCreditMemos")
          ? { autoCreatePalletCreditMemo: req.body.autoCreatePalletCreditMemos }
          : {})
    }, {
      operatorId: req.operator.id,
      allowCrossYard: true,
      allowAutomation: true
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/drafts/:draftId", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const draft = await getReturnDraftForControl(req.params.draftId, {
      receivingLocationIds: returnControlYardLocationIds(req.operator)
    });
    if (!draft) return res.status(404).json({ error: "Return draft was not found." });
    res.json(draft);
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/drafts/:draftId/discard", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await discardReturnDraftForControl({
      draftId: req.params.draftId,
      actorOperatorId: req.operator.id,
      receivingLocationIds: returnControlYardLocationIds(req.operator),
      reason: req.body?.reason
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const receivingLocationIds = returnControlYardLocationIds(req.operator);
    if (String(req.query.status || "").toLowerCase() === "draft") {
      const result = await listReturnDraftsForControl({
        receivingLocationIds,
        receivingLocationId: req.query.receivingLocationId || req.query.yardLocationId,
        search: req.query.search,
        returnType: req.query.type || req.query.recordType,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
        offset: req.query.offset
      });
      return res.json({ records: result.records, counts: { total: result.total } });
    }
    res.json(await listReturnRecords(returnListFilters(req, { receivingLocationIds })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/returns/:id", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    if (/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      const draft = await getReturnDraftForControl(req.params.id, {
        receivingLocationIds: returnControlYardLocationIds(req.operator)
      });
      if (!draft) return res.status(404).json({ error: "Return draft was not found." });
      return res.json(draft);
    }
    const record = await getReturnRecordDetail(req.params.id, {
      receivingLocationIds: returnControlYardLocationIds(req.operator)
    });
    if (!record) return res.status(404).json({ error: "Return record was not found." });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/:id/lines/:lineId/decision", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const record = await decideReturnLine({
      recordId: req.params.id,
      lineId: req.params.lineId,
      decision: req.body?.decision,
      note: req.body?.note ?? req.body?.reason,
      actorOperatorId: req.operator.id,
      allowedReceivingLocationIds: returnControlYardLocationIds(req.operator)
    });
    emitAppEvent("returns.updated", { source: "approval-decision", recordId: record.id });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/:id/void", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const record = await voidReturnRecord({
      recordId: req.params.id,
      reason: req.body?.reason,
      actorOperatorId: req.operator.id,
      allowedReceivingLocationIds: returnControlYardLocationIds(req.operator)
    });
    emitAppEvent("returns.updated", { source: "void", recordId: record.id });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns/:id/sync/retry", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const current = await getReturnRecordDetail(req.params.id, {
      receivingLocationIds: returnControlYardLocationIds(req.operator)
    });
    if (!current) return res.status(404).json({ error: "Return record was not found." });
    if (current.netSuiteSyncStatus !== "failed") {
      return res.status(409).json({ error: "Only a failed NetSuite return synchronization can be retried." });
    }
    res.json(await syncReturnRecord({
      recordId: current.id,
      actorOperatorId: req.operator.id,
      force: true
    }));
  } catch (error) {
    next(error);
  }
});

async function linkReturnNetSuiteRoute(req, res, next) {
  try {
    res.json(await linkReturnNetSuiteTransaction({
      recordId: req.params.id,
      transactionType: req.body?.transactionType,
      netsuiteId: req.body?.netsuiteId,
      netsuiteTranid: req.body?.netsuiteTranid,
      actorOperatorId: req.operator.id
    }));
  } catch (error) {
    next(error);
  }
}

app.post("/api/returns/:id/netsuite-link", requireOperator, requireAdmin, linkReturnNetSuiteRoute);
app.post("/api/returns/:id/net-suite-link", requireOperator, requireAdmin, linkReturnNetSuiteRoute);

app.post("/api/admin/returns/reconcile", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await reconcileReturnRecords({
      limit: req.body?.limit,
      actorOperatorId: req.operator.id
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/returns", requirePrivateSalesRecordAccess, async (req, res, next) => {
  try {
    const authorized = operatorSalesYardLocationIds(req.operator);
    const requestedYard = Number(req.query.orderingLocationId || req.query.yardLocationId || req.query.yard);
    const orderingLocationIds = Number.isInteger(requestedYard) && requestedYard > 0
      ? authorized.filter((locationId) => locationId === requestedYard)
      : authorized;
    res.json(await listReturnRecords(returnListFilters(req, {
      receivingLocationId: "",
      orderingLocationIds: orderingLocationIds.length ? orderingLocationIds : [-1]
    })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sales/returns/:id", requirePrivateSalesRecordAccess, async (req, res, next) => {
  try {
    const authorized = operatorSalesYardLocationIds(req.operator);
    const record = await getReturnRecordDetail(req.params.id, {
      orderingLocationIds: authorized.length ? authorized : [-1]
    });
    if (!record) return res.status(404).json({ error: "Return record was not found." });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

async function listOperatorOrderLocks() {
  const result = await query(
    `WITH lock_source AS (
       SELECT 'sales_order'::text AS order_type,
              o.netsuite_id,
              o.tranid,
              o.operator_status AS operator_status,
              o.local_yard_order_status,
              o.outbound_location,
              o.preparing_operator_id,
              o.preparing_started_at,
              op.username,
              op.display_name,
              (
                SELECT COUNT(*)::int
                  FROM sales_order_lines l
                 WHERE l.sales_order_id = o.netsuite_id
                   AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                   AND (
                     COALESCE(l.packed_pallet_qty, 0) > 0
                     OR COALESCE(l.packed_layer_qty, 0) > 0
                     OR COALESCE(l.packed_section_qty, 0) > 0
                     OR COALESCE(l.packed_piece_qty, 0) > 0
                     OR COALESCE(l.packed_sales_qty, 0) > 0
                   )
              ) AS draft_line_count
         FROM sales_orders o
         LEFT JOIN operators op ON op.id::text = o.preparing_operator_id::text
        WHERE o.preparing_operator_id IS NOT NULL
       UNION ALL
       SELECT 'transfer_order'::text AS order_type,
              o.netsuite_id,
              o.tranid,
              o.outbound_operator_status AS operator_status,
              o.local_yard_order_status,
              o.from_location AS outbound_location,
              o.preparing_operator_id,
              o.preparing_started_at,
              op.username,
              op.display_name,
              (
                SELECT COUNT(*)::int
                  FROM transfer_order_lines l
                 WHERE l.transfer_order_id = o.netsuite_id
                   AND l.line_stage = 'outbound'
                   AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                   AND (
                     COALESCE(l.packed_pallet_qty, 0) > 0
                     OR COALESCE(l.packed_layer_qty, 0) > 0
                     OR COALESCE(l.packed_section_qty, 0) > 0
                     OR COALESCE(l.packed_piece_qty, 0) > 0
                     OR COALESCE(l.packed_sales_qty, 0) > 0
                   )
              ) AS draft_line_count
         FROM transfer_orders o
         LEFT JOIN operators op ON op.id::text = o.preparing_operator_id::text
        WHERE o.preparing_operator_id IS NOT NULL
     )
     SELECT *
       FROM lock_source
      ORDER BY preparing_started_at DESC NULLS LAST, tranid`
  );
  return result.rows;
}

async function releaseOperatorOrderLock({ orderType, orderId, actorOperatorId }) {
  const isTransfer = orderType === "transfer_order";
  const targetTable = isTransfer ? "transfer_orders" : "sales_orders";
  const result = await query(
    `UPDATE ${targetTable}
        SET preparing_operator_id = null,
            preparing_started_at = null,
            status_updated_at = now()
      WHERE netsuite_id = $1
        AND preparing_operator_id IS NOT NULL
      RETURNING netsuite_id, tranid`,
    [orderId]
  );
  if (!result.rowCount) return null;
  await writeAudit({
    actorOperatorId,
    source: "control",
    action: "operator.order_lock.release",
    orderId,
    details: {
      orderType: isTransfer ? "transfer_order" : "sales_order",
      tranid: result.rows[0].tranid
    }
  });
  emitAppEvent("delivery.order.updated", { orderId, source: "control-lock-release" });
  return result.rows[0];
}

app.get("/api/control/order-locks", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listOperatorOrderLocks());
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/order-locks/release", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const releaseAll = Boolean(req.body?.all);
    const locks = releaseAll
      ? await listOperatorOrderLocks()
      : [{
          order_type: req.body?.orderType === "transfer_order" ? "transfer_order" : "sales_order",
          netsuite_id: req.body?.orderId
        }];
    const released = [];
    for (const lock of locks) {
      if (!lock.netsuite_id) continue;
      const row = await releaseOperatorOrderLock({
        orderType: lock.order_type,
        orderId: lock.netsuite_id,
        actorOperatorId: req.operator.id
      });
      if (row) released.push({ ...row, order_type: lock.order_type });
    }
    res.json({ released, locks: await listOperatorOrderLocks() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/loaded-orders", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listYardMovements({
      from: req.query.from,
      to: req.query.to,
      yard: req.query.yard,
      search: req.query.search,
      itemSearch: req.query.itemSearch,
      direction: req.query.direction,
      orderType: req.query.orderType
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/loaded-orders/detail", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const detail = await getYardMovementDetail({
      direction: req.query.direction,
      orderType: req.query.orderType,
      orderId: req.query.orderId,
      from: req.query.from,
      to: req.query.to
    });
    if (!detail) return res.status(404).json({ error: "Yard movement not found." });
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/loaded-orders/export.csv", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    await sendLoadedOrdersCsv(req, res);
  } catch (error) {
    next(error);
  }
});


app.get("/api/admin/photo-archive", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await getPhotoArchiveSettings());
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/photo-archive", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await updatePhotoArchiveSettings(req.body || {}, req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/photo-archive/run", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const settings = await getPhotoArchiveSettings({ includeStats: false });
    if (settings.mode === "off") {
      return res.status(409).json({ error: "Turn Photo Archive on by selecting Manual or Auto mode first." });
    }
    if (isPhotoArchiveRunning()) {
      return res.status(202).json({ started: false, skipped: true, reason: "photo_archive_running", settings: await getPhotoArchiveSettings() });
    }
    const runner = runPhotoArchive({ source: "admin_manual", actorOperatorId: req.operator.id });
    runner.catch((error) => console.error("Background photo archive failed:", error));
    return res.status(202).json({ started: true, settings: await getPhotoArchiveSettings() });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/admin/netsuite-mirror", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await getNetSuiteMirrorStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/netsuite-mirror/retry", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const retried = await retryNetSuiteMirrorFailures();
    const result = isNetSuiteMirrorConsumer()
      ? await runNetSuiteMirrorConsumerTick()
      : await relayPendingNetSuiteMirrorEvents();
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "admin",
      action: "netsuite.mirror.retry",
      details: { retried, result }
    });
    res.json({ retried, result, status: await getNetSuiteMirrorStatus() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/netsuite-mirror/reconcile", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (!isNetSuiteMirrorConsumer()) return res.status(409).json({ error: "Reconciliation runs on the mirror consumer." });
    const result = await runNetSuiteMirrorReconciliation({ full: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "admin",
      action: "netsuite.mirror.reconcile",
      details: result
    });
    res.json({ result, status: await getNetSuiteMirrorStatus() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/scm-reconciliation/settings", requireOperator, requireAdmin, async (_req, res, next) => {
  try {
    res.json({ settings: await getScmReconciliationSettings() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/scm-reconciliation/settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const settings = await updateScmReconciliationSettings(req.body || {}, req.operator?.id);
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/scm-reconciliation/runs", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json({ runs: await listScmReconciliationRuns({ limit: req.query.limit || 30 }) });
  } catch (error) {
    next(error);
  }
});

app.put(
  "/api/control/scm-reconciliation/runs/:runId/targets/:targetId/decision",
  requireOperator,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await updateScmReconciliationRunTargetDecision({
        runId: req.params.runId,
        targetId: req.params.targetId,
        decision: req.body?.decision,
        note: req.body?.note,
        expectedUpdatedAt: req.body?.expectedUpdatedAt ?? req.body?.expected_updated_at,
        actor: req.operator?.id
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/control/scm-reconciliation/run", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const requestedScope = String(req.body?.scope || "").trim();
    const targetedScope = /^order[_ -]?family$/i.test(requestedScope);
    const run = await startScmReconciliationRun({
      scope: requestedScope,
      soOrderType: req.body?.soOrderType ?? req.body?.so_order_type,
      targetOrderKind: req.body?.orderKind ?? req.body?.targetOrderKind,
      targetOrderId: req.body?.orderId ?? req.body?.targetOrderId,
      targetOrderRef: req.body?.orderRef ?? req.body?.targetOrderRef,
      targetOrderRefs: req.body?.orderRefs ?? req.body?.targetOrderRefs,
      includeTerminalOrders: targetedScope
        ? true
        : (req.body?.includeTerminalOrders ?? req.body?.include_terminal_orders),
      dryRun: req.body?.dryRun ?? req.body?.dry_run,
      applyUnambiguous: true,
      triggerSource: "manual",
      requestedBy: req.operator?.id
    }, {
      background: true,
      operationalSyncRunning: anyNetSuiteSyncRunning
    });
    res.status(202).json({ started: true, run });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/control/scm-reconciliation/runs/:id/stop",
  requireOperator,
  requireAdmin,
  async (req, res, next) => {
    try {
      const result = await cancelScmReconciliationRun(
        req.params.id,
        req.operator?.id,
        req.body?.note
      );
      emitAppEvent("dispatch.orders.updated", {
        source: "scm-reconciliation-stop",
        runId: Number(req.params.id) || null
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/control/scm-reconciliation/runs/:id/resume",
  requireOperator,
  requireAdmin,
  async (req, res, next) => {
    try {
      const run = await resumeScmReconciliationRun(
        req.params.id,
        req.operator?.id,
        {
          background: true,
          operationalSyncRunning: anyNetSuiteSyncRunning
        }
      );
      emitAppEvent("dispatch.orders.updated", {
        source: "scm-reconciliation-resume",
        runId: Number(req.params.id) || null
      });
      res.status(202).json({ started: true, run });
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/control/scm-reconciliation/runs/:id/apply", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const result = await applyScmReconciliationRun(
      req.params.id,
      req.operator?.id,
      {
        background: true,
        operationalSyncRunning: anyNetSuiteSyncRunning
      }
    );
    if (result.pending) return res.status(202).json(result);
    if (!result.applied) {
      return res.status(409).json({
        ...result,
        error: result.applyRun?.error || "The reconciliation apply did not succeed."
      });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/sync-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const setup = await readDispatchSetup();
    res.json(setup.sync);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/env-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listEnvFiles());
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/vendor-mappings", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listDispatchVendorMappings());
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/vendor-mappings/discover", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const result = await discoverDispatchVendorMappingsFromPurchaseOrders();
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "vendor_mapping.discover",
      details: { scanned: result.scanned, inserted: result.inserted, updated: result.updated, enriched }
    });
    emitAppEvent("dispatch.orders.updated", { source: "vendor-mapping-discover", enriched });
    res.json({ ...result, enriched });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/local-vendors", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const created = await createDispatchLocalVendor({
      name: req.body?.name,
      updatedBy: req.operator.display_name || req.operator.username || req.operator.id
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "local_vendor.create",
      details: { localVendor: created }
    });
    res.json({ created, ...(await listDispatchVendorMappings()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/local-vendors/:id", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const updated = await updateDispatchLocalVendor(req.params.id, {
      name: req.body?.name,
      active: req.body?.active,
      updatedBy: req.operator.display_name || req.operator.username || req.operator.id
    });
    if (!updated) return res.status(404).json({ error: "Local vendor not found." });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "local_vendor.update",
      details: { localVendor: updated, enriched }
    });
    emitAppEvent("dispatch.vendor_mapping.updated", { localVendorId: req.params.id });
    emitAppEvent("dispatch.orders.updated", { source: "local-vendor-update", enriched });
    res.json({ updated, enriched, ...(await listDispatchVendorMappings()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/vendor-mappings/:id", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    const updated = await updateDispatchVendorMapping(req.params.id, {
      ...req.body,
      updatedBy: req.operator.display_name || req.operator.username || req.operator.id
    });
    if (!updated) return res.status(404).json({ error: "Vendor mapping not found." });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "vendor_mapping.update",
      details: { mapping: updated, enriched }
    });
    emitAppEvent("dispatch.vendor_mapping.updated", { id: req.params.id });
    emitAppEvent("dispatch.orders.updated", { source: "vendor-mapping", enriched });
    res.json({ updated, enriched, ...(await listDispatchVendorMappings()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/env-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (anyNetSuiteSyncRunning()) return res.status(409).json({ error: "Stop the current sync before switching env file." });
    const settings = await selectEnvFile(req.body?.envFile, { applyNow: Boolean(req.body?.applyNow) });
    if (settings.appliedNow && settings.previousActiveEnvFile !== settings.activeEnvFile) {
      await pool.query("DELETE FROM netsuite_tokens");
    }
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "env.file_select",
      details: {
        activeEnvFile: settings.activeEnvFile,
        selectedEnvFile: settings.selectedEnvFile,
        restartRequired: settings.restartRequired,
        appliedNow: settings.appliedNow,
        applyError: settings.applyError || ""
      }
    });
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/sync-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const mode = req.body?.mode === "auto" ? "auto" : "manual";
    const syncPatch = { mode };
    if (Object.hasOwn(req.body || {}, "maxRunSeconds")) {
      syncPatch.maxRunSeconds = req.body.maxRunSeconds;
    }
    const setup = await writeDispatchSetup({ sync: syncPatch });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "sync.mode_update",
      details: syncPatch
    });
    emitAppEvent("dispatch.sync.settings.updated", { mode });
    res.json(setup.sync);
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/sync-order", requireOperator, requireAdmin, async (req, res, next) => {
  if (anyNetSuiteSyncRunning()) {
    return res.status(409).json({ error: "Another NetSuite sync is currently running. Wait for it to finish, then retry this order." });
  }
  targetedSyncRunning = true;
  try {
    const result = await syncTargetedNetSuiteOrder({
      orderRef: req.body?.orderRef,
      actorOperatorId: req.operator.id
    }, targetedOrderSyncDependencies);
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    targetedSyncRunning = false;
  }
});

app.post("/api/control/sync-now", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (anyNetSuiteSyncRunning()) {
      return res.status(202).json({
        started: false,
        skipped: true,
        reason: "sync_running",
        settings: (await readDispatchSetup()).sync
      });
    }
    const startedAt = new Date().toISOString();
    const runner = runDispatchSync({ source: "control_manual", actorOperatorId: req.operator.id });
    runner.catch((error) => {
      console.error("Background NetSuite sync failed:", error);
    });
    res.status(202).json({
      started: true,
      background: true,
      message: "Sync started.",
      settings: {
        ...(await readDispatchSetup()).sync,
        running: true,
        lastStartedAt: startedAt,
        lastSource: "control_manual",
        lastStatus: "running",
        lastError: ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/sync-transfer-orders", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (anyNetSuiteSyncRunning()) {
      return res.status(202).json({
        started: false,
        skipped: true,
        reason: "sync_running",
        settings: (await readDispatchSetup()).sync
      });
    }
    const startedAt = new Date().toISOString();
    const source = "control_inbound_transfer_manual";
    const runner = runDispatchSync({ source, actorOperatorId: req.operator.id, orderScope: "transfer_purchase_order" });
    runner.catch((error) => {
      console.error("Background NetSuite TO/PO sync failed:", error);
    });
    res.status(202).json({
      started: true,
      background: true,
      message: "Transfer/Purchase Order sync started.",
      settings: {
        ...(await readDispatchSetup()).sync,
        running: true,
        lastStartedAt: startedAt,
        lastSource: source,
        lastStatus: "running",
        lastError: ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/netsuite-progress/reconcile", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (anyNetSuiteSyncRunning()) {
      return res.status(202).json({
        started: false,
        skipped: true,
        reason: "sync_running",
        settings: (await readDispatchSetup()).sync
      });
    }
    const startedAt = new Date().toISOString();
    const runner = runNetSuiteProgressReconcile({ source: "control_progress_reconcile", actorOperatorId: req.operator.id });
    runner.catch((error) => {
      console.error("Background NetSuite progress reconcile failed:", error);
    });
    res.status(202).json({
      started: true,
      background: true,
      message: "NetSuite progress reconcile started.",
      settings: {
        ...(await readDispatchSetup()).sync,
        running: true,
        lastStartedAt: startedAt,
        lastSource: "control_progress_reconcile",
        lastStatus: "running",
        lastError: ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/sync-stop", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const settings = await stopDispatchSync({ actorOperatorId: req.operator.id });
    emitAppEvent("dispatch.sync.settings.updated", { mode: settings.mode, status: settings.lastStatus });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/order-data/clear", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (req.body?.confirmText !== "CLEAR ORDERS") {
      return res.status(400).json({ error: "Type CLEAR ORDERS to clear operational order data." });
    }
    const result = await clearOperationalOrderData({ actorOperatorId: req.operator.id });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/audit", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listAudit({
      limit: req.query.limit,
      orderId: req.query.orderId,
      operatorId: req.query.operatorId,
      from: req.query.from,
      to: req.query.to,
      actor: req.query.actor,
      action: req.query.action,
      tranid: req.query.tranid
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/audit/options", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listAuditOptions({
      from: req.query.from,
      to: req.query.to,
      tranid: req.query.tranid
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/fulfillments", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listDeliveryFulfillments({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operator/history", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    res.json(await listOperatorHistory({
      operatorId: req.operator.id,
      date: req.query.date || "",
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operator/requests", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    res.json(await listDispatchOperatorRequests({
      status: req.query.status || "open",
      locationId: req.query.locationId || null,
      orderType: req.query.orderType || null
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/operator/history/report-error", requireOperator, requireOperatorAccess, async (req, res, next) => {
  try {
    res.json(await reportOperatorRecordError({
      operatorId: req.operator.id,
      recordId: req.body?.recordId,
      reason: req.body?.reason
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/record-warnings", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listRecordWarnings({
      status: req.query.status || "",
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/record-warnings/:id/resolve", requireOperator, requireControlAccess, async (req, res, next) => {
  try {
    res.json(await resolveRecordWarning({
      warningId: req.params.id,
      handledBy: req.operator.id,
      resolution: req.body?.resolution
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/netsuite/start", (req, res, next) => {
  try {
    const { url } = buildAuthorizationUrl();
    res.redirect(url);
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/netsuite/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`NetSuite authorization failed: ${req.query.error}`);
    }
    await exchangeCodeForToken(req.query.code);
    res.send("NetSuite connected. You can close this tab and return to the yard app.");
  } catch (error) {
    next(error);
  }
});

app.use("/api/delivery", requireOperator, requireOperatorAccess);
app.use("/api/customer-pickup", requireOperator, requireOperatorAccess);
app.use("/api/receiving", requireOperator, requireOperatorAccess);
app.use("/api/inventory", requireOperator, requireOperatorAccess);
app.use("/api/cycle-count", requireOperator, requireOperatorAccess);

app.use("/api/delivery/orders/:id", async (req, res, next) => {
  try {
    if (await isBilledSalesOrderIdentifier(req.params.id)) {
      return res.status(404).json({ error: "Delivery order not found." });
    }
    if (isNetSuiteSandboxEnvironment()) return next();
    const orderId = String(req.params.id || "").trim();
    const fixture = await query(
      `SELECT 1
         FROM sales_orders
        WHERE COALESCE(is_test_fixture, false) = true
          AND (tranid = $1 OR ($2::bigint IS NOT NULL AND netsuite_id = $2::bigint))
        LIMIT 1`,
      [orderId, /^\d+$/.test(orderId) ? Number(orderId) : null]
    );
    if (fixture.rowCount) return res.status(404).json({ error: "Delivery order not found." });
    next();
  } catch (error) {
    next(error);
  }
});

app.use("/api/customer-pickup/orders/:id", async (req, res, next) => {
  try {
    if (await isBilledSalesOrderIdentifier(req.params.id)) {
      return res.status(404).json({ error: "Pickup sales order not found." });
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/lookup", async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim();
    const locationId = Number(req.body?.locationId || req.query.locationId || 0) || null;
    if (!code) return res.status(400).json({ error: "Scan or enter a sales order number." });
    let orderId = await findCustomerPickupOrder(code, { locationId });
    if (!orderId) {
      const order = await fetchCustomerPickupOrderFromNetSuite(code, locationId);
      if (!order) return res.status(404).json({ error: "Pickup sales order not found for this location." });
      if (isNetSuiteSalesOrderBilled(order)) {
        return res.status(404).json({ error: "Pickup sales order not found for this location." });
      }
      if (isPendingApprovalStatus(order.status, order.status_text)) {
        return res.status(409).json({ error: "This pickup sales order is still pending approval in NetSuite." });
      }
      await upsertSalesOrders([order]);
      const lines = await fetchDeliveryOrderDetailsFromNetSuite(order.id, locationId);
      await upsertSalesOrderLines(order.id, lines);
      await markMissingOutboundOrderLines(order.id, lines.map((line) => line.line_id));
      orderId = order.id;
    }
    const detail = await getDeliveryOrder(orderId);
    if (!detail || !isPickupDeliveryMethod(detail.delivery_method)) {
      return res.status(409).json({ error: "This sales order is not a customer pickup order." });
    }
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "customer_pickup",
      action: "customer_pickup.order.lookup",
      orderId,
      details: { code, locationId }
    });
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    await confirmCustomerPickupLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, source: "customer-pickup", operatorId: operatorId(req) });
    res.json(await getDeliveryOrder(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/orders/:id/clear-draft", async (req, res, next) => {
  try {
    const order = await clearCustomerPickupDraft(req.params.id, operatorId(req));
    emitAppEvent("delivery.line.updated", { orderId: req.params.id, source: "customer-pickup-clear", operatorId: operatorId(req) });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/orders/:id/load", async (req, res, next) => {
  try {
    const photoDataUrls = requiredPhotoDataUrls(req.body?.photoDataUrls);
    const result = await recordCustomerPickupLoad(req.params.id, operatorId(req), {
      photoDataUrls
    });
    emitAppEvent("delivery.order.loaded", { orderId: req.params.id, source: "customer-pickup", operatorId: operatorId(req), result });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/sync", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId || req.query.locationId || 1);
    const orderType = normalizeOrderType(req.body?.orderType || req.query.orderType);
    const orders = await listDeliveryOrders({
      locationId,
      status: req.body?.status || req.query.status || null,
      orderType
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.local_order_refresh",
      details: { locationId, orderType, count: orders.length }
    });
    res.json({ localOnly: true, orders });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/sync", async (req, res, next) => {
  try {
    const orderType = normalizeOrderType(req.body?.orderType || req.query.orderType);
    const order = await getDeliveryOrder(req.params.id);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.local_order_detail_refresh",
      orderId: auditOrderId(req.params.id),
      details: { orderRef: req.params.id, orderType, found: Boolean(order), lines: order?.lines?.length || 0 }
    });
    res.json({ localOnly: true, order: Boolean(order), synced: 0, lines: order?.lines?.length || 0 });
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/orders", async (req, res, next) => {
  try {
    res.json(await listDeliveryOrders({
      locationId: req.query.locationId,
      status: req.query.status,
      orderType: normalizeOrderType(req.query.orderType)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/vrma-orders", async (req, res, next) => {
  try {
    res.json(await listVrmaDeliveryPrepOrders({
      locationId: req.query.locationId,
      status: req.query.status || "active"
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/bootstrap", async (req, res, next) => {
  try {
    res.json(await getDeliveryBootstrap({
      operatorId: operatorId(req),
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/load-trucks", async (req, res, next) => {
  try {
    res.json(await listDeliveryLoadTrucks({
      locationId: req.query.locationId,
      planDate: req.query.planDate
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/load-orders", async (req, res, next) => {
  try {
    res.json(await listDeliveryLoadOrders({
      locationId: req.query.locationId,
      status: req.query.status,
      planDate: req.query.planDate,
      truckPlate: req.query.truckPlate
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/saved-orders", async (req, res, next) => {
  try {
    res.json(await listSavedDeliveryOrdersForOperator(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/saved-order-keys", async (req, res, next) => {
  try {
    res.json(await listSavedDeliveryOrderKeysForOperator(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/saved-orders", async (req, res, next) => {
  try {
    if (await isBilledSalesOrderIdentifier(req.body?.orderId)) {
      return res.status(404).json({ error: "Delivery order not found." });
    }
    res.json(await saveDeliveryOrderForOperator(operatorId(req), {
      locationId: req.body?.locationId || req.query.locationId,
      orderId: req.body?.orderId
    }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/delivery/saved-orders/:id", async (req, res, next) => {
  try {
    res.json(await removeSavedDeliveryOrderForOperator(operatorId(req), {
      locationId: req.query.locationId || req.body?.locationId,
      orderId: req.params.id
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/consolidation/queue", async (req, res, next) => {
  try {
    res.json(await getSavedConsolidationQueue(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/consolidation/active", async (req, res, next) => {
  try {
    res.json(await getActiveConsolidationBatch(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/consolidation/start", async (req, res, next) => {
  try {
    const result = await startSavedConsolidationBatch(operatorId(req), {
      locationId: req.body?.locationId || req.query.locationId
    });
    emitAppEvent("delivery.consolidation.updated", {
      batchId: result?.batch?.id || null,
      change: "started",
      operatorId: operatorId(req)
    });
    res.json(result);
  } catch (error) {
    if (error.details) {
      return res.status(error.status || 409).json({ error: error.message, code: error.code, details: error.details });
    }
    next(error);
  }
});

app.put("/api/delivery/consolidation/orders/:batchOrderId/lines/:lineKey", async (req, res, next) => {
  try {
    const result = await updateConsolidationLine(
      operatorId(req),
      req.params.batchOrderId,
      req.params.lineKey,
      req.body?.values || req.body || {}
    );
    emitAppEvent("delivery.consolidation.updated", {
      batchId: result?.batch?.id || null,
      batchOrderId: req.params.batchOrderId,
      lineKey: req.params.lineKey,
      change: "line_updated",
      operatorId: operatorId(req)
    });
    emitAppEvent("delivery.line.updated", {
      orderId: result?.orders?.find((order) => String(order.id) === String(req.params.batchOrderId))?.orderKey || null,
      source: "consolidation",
      operatorId: operatorId(req)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.put("/api/delivery/consolidation/batches/:batchId/items/confirm", async (req, res, next) => {
  try {
    const result = await confirmConsolidationItem(operatorId(req), req.params.batchId, req.body?.itemKey);
    emitAppEvent("delivery.consolidation.updated", {
      batchId: result?.batch?.id || req.params.batchId,
      itemKey: req.body?.itemKey || "",
      change: "item_confirmed",
      operatorId: operatorId(req)
    });
    emitAppEvent("delivery.line.updated", {
      source: "consolidation",
      change: "item_confirmed",
      operatorId: operatorId(req)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/consolidation/orders/:batchOrderId/pack", async (req, res, next) => {
  try {
    const result = await packConsolidationOrder(operatorId(req), req.params.batchOrderId);
    emitAppEvent("delivery.consolidation.updated", {
      batchId: result?.batch?.id || result?.batchId || null,
      batchOrderId: req.params.batchOrderId,
      change: result?.completed ? "completed" : "order_packed",
      operatorId: operatorId(req)
    });
    emitAppEvent("delivery.order.updated", {
      source: "consolidation",
      change: "packed",
      operatorId: operatorId(req)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/consolidation/release", async (req, res, next) => {
  try {
    const result = await releaseConsolidationBatch(operatorId(req), {
      locationId: req.body?.locationId || req.query.locationId
    });
    emitAppEvent("delivery.consolidation.updated", {
      batchId: result?.batchId || null,
      change: "released",
      operatorId: operatorId(req)
    });
    emitAppEvent("delivery.order.updated", {
      source: "consolidation",
      change: "released",
      operatorId: operatorId(req)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/notifications", async (req, res, next) => {
  try {
    res.json(await getDeliveryPrepNotifications({
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/current-draft", async (req, res, next) => {
  try {
    res.json(await getCurrentOperatorDeliveryDraft(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/orders/:id", async (req, res, next) => {
  try {
    const order = await getDeliveryOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Delivery order not found" });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/sync", async (req, res, next) => {
  try {
    const orderType = req.body?.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "receiving",
      action: "operator.receiving_local_refresh",
      details: {
        orderType: req.body?.orderType === "co_order" ? "co_order" : orderType,
        sourceLocationId: req.body?.sourceLocationId || null,
        destinationLocationId: req.body?.destinationLocationId || req.body?.locationId || null
      }
    });
    res.json({ localOnly: true, synced: 0 });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/vendors", async (req, res, next) => {
  try {
    res.json(await listReceivingVendors({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/sources", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await listLocalCoSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
    }
    res.json(await listReceivingSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders", async (req, res, next) => {
  try {
    if (req.query.orderType === "all") {
      const destinationLocationId = req.query.destinationLocationId || req.query.locationId || null;
      const [purchaseOrders, transferOrders, coOrders] = await Promise.all([
        listReceivingOrders({
          orderType: "purchase_order",
          destinationLocationId,
          search: req.query.search || null,
          itemSearch: req.query.itemSearch || null
        }),
        listReceivingOrders({
          orderType: "transfer_order",
          destinationLocationId,
          search: req.query.search || null,
          itemSearch: req.query.itemSearch || null
        }),
        listLocalCoReceivingOrders({
          destinationLocationId,
          search: req.query.search || null,
          itemSearch: req.query.itemSearch || null
        })
      ]);
      return res.json([...purchaseOrders, ...transferOrders, ...coOrders].sort((a, b) => {
        const dateCompare = String(b.trandate || "").localeCompare(String(a.trandate || ""));
        if (dateCompare) return dateCompare;
        return String(b.tranid || "").localeCompare(String(a.tranid || ""));
      }).slice(0, 200));
    }
    if (req.query.orderType === "co_order") {
      return res.json(await listLocalCoReceivingOrders({
        sourceLocationId: req.query.sourceLocationId || null,
        destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
        search: req.query.search || null,
        itemSearch: req.query.itemSearch || null
      }));
    }
    const orderType = req.query.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    res.json(await listReceivingOrders({
      orderType,
      vendor: req.query.vendor || null,
      sourceLocationId: req.query.sourceLocationId || null,
      destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
      search: req.query.search || null,
      itemSearch: req.query.itemSearch || null
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/items", async (req, res, next) => {
  try {
    if (req.query.orderType === "all") {
      const destinationLocationId = req.query.destinationLocationId || req.query.locationId || null;
      const [purchaseItems, transferItems, coItems] = await Promise.all([
        searchReceivingItems({ orderType: "purchase_order", destinationLocationId, search: req.query.search || "" }),
        searchReceivingItems({ orderType: "transfer_order", destinationLocationId, search: req.query.search || "" }),
        searchLocalCoItems({ destinationLocationId, search: req.query.search || "" })
      ]);
      const byName = new Map();
      for (const item of [...purchaseItems, ...transferItems, ...coItems]) {
        const key = String(item.item_name || item.item_id || "").toLowerCase();
        const current = byName.get(key) || { ...item, order_count: 0 };
        current.order_count = Number(current.order_count || 0) + Number(item.order_count || 0);
        current.item_description = current.item_description || item.item_description || "";
        byName.set(key, current);
      }
      return res.json([...byName.values()].sort((a, b) => Number(b.order_count || 0) - Number(a.order_count || 0)).slice(0, 12));
    }
    if (req.query.orderType === "co_order") {
      return res.json(await searchLocalCoItems({
        sourceLocationId: req.query.sourceLocationId || null,
        destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
        search: req.query.search || ""
      }));
    }
    const orderType = req.query.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    res.json(await searchReceivingItems({
      orderType,
      vendor: req.query.vendor || null,
      sourceLocationId: req.query.sourceLocationId || null,
      destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
      search: req.query.search || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/sync", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || req.query.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      return res.json({ localOnly: true, synced: { order: true, orderType: "co_order", lines: 0 } });
    }
    const order = await getReceivingOrder(req.params.id);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "receiving",
      action: "operator.receiving_order_local_refresh",
      details: { receivingOrderId: req.params.id, found: Boolean(order), lines: order?.lines?.length || 0 }
    });
    res.json({ localOnly: true, synced: { order: Boolean(order), lines: order?.lines?.length || 0 } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders/:id", async (req, res, next) => {
  try {
    const requestedType = req.query.orderType || "";
    if (requestedType !== "co_order") {
      const order = await getReceivingOrder(req.params.id);
      if (order) return res.json(order);
    }
    if (requestedType === "co_order" || String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const localOrder = await getLocalCoReceivingOrder(req.params.id);
      if (!localOrder) return res.status(404).json({ error: "Local CO not found" });
      return res.json(localOrder);
    }
    return res.status(404).json({ error: "Receiving order not found" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      const result = await confirmLocalCoReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
      emitAppEvent("receiving.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: "co_order", operatorId: operatorId(req) });
      return res.json(result);
    }
    const result = await confirmReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("receiving.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: req.body?.orderType || null, operatorId: operatorId(req) });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/lines/:lineId/unconfirm", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      const result = await unconfirmLocalCoReceivingLine(req.params.id, req.params.lineId, operatorId(req));
      emitAppEvent("receiving.line.unconfirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: "co_order", operatorId: operatorId(req) });
      return res.json(result);
    }
    const result = await unconfirmReceivingLine(req.params.id, req.params.lineId, operatorId(req));
    emitAppEvent("receiving.line.unconfirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: req.body?.orderType || null, operatorId: operatorId(req) });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/receive", async (req, res, next) => {
  try {
    req.body = { ...(req.body || {}), photoDataUrls: requiredPhotoDataUrls(req.body?.photoDataUrls) };
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      const result = await receiveLocalCoOrder(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls
      });
      emitAppEvent("receiving.order.received", { orderId: req.params.id, orderType: "co_order", operatorId: operatorId(req) });
      emitAppEvent("delivery.order.updated", { orderId: result.deliveryOrderId, coOrderId: req.params.id, orderType: "co_order", source: "co-received" });
      emitAppEvent("dispatch.orders.updated", { orderId: result.deliveryOrderId, coOrderId: req.params.id, source: "co-received" });
      return res.json({ jobId: null, status: "complete", result });
    }
    const jobId = crypto.randomUUID();
    receivingJobs.set(jobId, {
      id: jobId,
      status: "running",
      orderId: req.params.id,
      stage: "queued",
      message: "Receiving request received.",
      startedAt: new Date().toISOString()
    });
    res.json({ jobId, status: "running" });
    Promise.resolve().then(async () => {
      const result = await runReceivingReceipt(req.params.id, req.body || {}, operatorId(req), jobId);
      updateReceivingJob(jobId, {
        status: "complete",
        stage: "complete",
        message: result.itemReceiptTranid ? `Created ${result.itemReceiptTranid}.` : "Item Receipt created.",
        result,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("receiving.order.received", { orderId: req.params.id, orderType: req.body?.orderType || null, operatorId: operatorId(req), jobId, itemReceiptTranid: result.itemReceiptTranid || null });
    }).catch(async (error) => {
      const job = receivingJobs.get(jobId);
      await recordReceivingReceiptFailure(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls,
        payload: job?.payload,
        error,
        stage: job?.stage
      });
      updateReceivingJob(jobId, {
        status: "error",
        stage: "error",
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("receiving.order.receive_failed", { orderId: req.params.id, operatorId: operatorId(req), jobId, error: error.message });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/receipt-jobs/:jobId", async (req, res, next) => {
  try {
    const job = receivingJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Receiving job not found" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/prepared", async (req, res, next) => {
  try {
    await markDeliveryPrepared(req.params.id, req.body || {});
    emitAppEvent("delivery.order.updated", { orderId: req.params.id, change: "prepared" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/status", async (req, res, next) => {
  try {
    await updateDeliveryStatus(req.params.id, req.body?.status, operatorId(req));
    const dependencyProgress = await syncDirectDependencyOperatorProgress(req.params.id);
    const order = await getDeliveryOrder(req.params.id);
    emitAppEvent("delivery.order.updated", { orderId: req.params.id, status: req.body?.status, operatorId: operatorId(req) });
    res.json({ ok: true, dependencyProgress, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/release-draft", async (req, res, next) => {
  try {
    const order = await releaseCurrentDeliveryDraft(req.params.id, operatorId(req));
    emitAppEvent("delivery.order.updated", {
      orderId: req.params.id,
      status: order?.operator_status || null,
      change: "draft_released",
      operatorId: operatorId(req)
    });
    res.json({ ok: true, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    await confirmDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    const order = await getDeliveryOrder(req.params.id);
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, operatorId: operatorId(req) });
    res.json({ ok: true, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/confirm-page", async (req, res, next) => {
  try {
    const result = await confirmDeliveryLines(req.params.id, req.body?.lines || [], operatorId(req));
    const order = await getDeliveryOrder(req.params.id);
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, count: result.confirmed, operatorId: operatorId(req), bulk: true });
    res.json({ ok: true, ...result, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/packed-quantity", async (req, res, next) => {
  try {
    await setDeliveryLinePackedQuantity(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    const order = await getDeliveryOrder(req.params.id);
    emitAppEvent("delivery.line.updated", { orderId: req.params.id, lineId: req.params.lineId, change: "packed_quantity", operatorId: operatorId(req) });
    res.json({ ok: true, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    await syncDirectDependencyOperatorProgress(req.params.id);
    const resolvedRequests = await resolveDispatchOperatorRequestsForOrder(req.params.id, operatorId(req)).catch(() => []);
    const order = await getDeliveryOrder(req.params.id);
    emitAppEvent("delivery.order.unpacked", { orderId: req.params.id, lineId: req.params.lineId, operatorId: operatorId(req), resolvedRequestIds: resolvedRequests.map((request) => request.id) });
    res.json({ ok: true, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryOrder(req.params.id, operatorId(req));
    await syncDirectDependencyOperatorProgress(req.params.id);
    const resolvedRequests = await resolveDispatchOperatorRequestsForOrder(req.params.id, operatorId(req)).catch(() => []);
    const order = await getDeliveryOrder(req.params.id);
    emitAppEvent("delivery.order.unpacked", { orderId: req.params.id, operatorId: operatorId(req), resolvedRequestIds: resolvedRequests.map((request) => request.id) });
    res.json({ ok: true, order });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/fulfill", async (req, res, next) => {
  try {
    req.body = { ...(req.body || {}), photoDataUrls: requiredPhotoDataUrls(req.body?.photoDataUrls) };
    const jobId = crypto.randomUUID();
    fulfillmentJobs.set(jobId, {
      id: jobId,
      status: "running",
      orderId: req.params.id,
      stage: "queued",
      message: "Fulfillment request received.",
      startedAt: new Date().toISOString()
    });
    res.json({ jobId, status: "running" });
    Promise.resolve().then(async () => {
      const result = await runDeliveryFulfillment(req.params.id, req.body || {}, operatorId(req), jobId);
      updateFulfillmentJob(jobId, {
        status: "complete",
        stage: "complete",
        message: result.itemFulfillmentTranid ? `Created ${result.itemFulfillmentTranid}.` : "Item Fulfillment created.",
        result,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("delivery.order.fulfilled", { orderId: req.params.id, operatorId: operatorId(req), jobId, itemFulfillmentTranid: result.itemFulfillmentTranid || null });
    }).catch(async (error) => {
      const job = fulfillmentJobs.get(jobId);
      await recordDeliveryFulfillmentFailure(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls,
        payload: job?.payload,
        error,
        stage: job?.stage
      });
      updateFulfillmentJob(jobId, {
        status: "error",
        stage: "error",
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("delivery.order.fulfill_failed", { orderId: req.params.id, operatorId: operatorId(req), jobId, error: error.message });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/load", async (req, res, next) => {
  try {
    const photoDataUrls = requiredPhotoDataUrls(req.body?.photoDataUrls);
    const result = await recordDeliveryLoad(req.params.id, operatorId(req), {
      photoDataUrls
    });
    result.dependencyProgress = result.localOnly
      ? null
      : await syncDirectDependencyOperatorProgress(req.params.id);
    emitAppEvent("delivery.order.loaded", { orderId: req.params.id, operatorId: operatorId(req), resultId: result?.id || null });
    if (Array.isArray(result?.activatedCo) && result.activatedCo.length) {
      emitAppEvent("receiving.order.updated", { orderId: req.params.id, activatedCo: result.activatedCo, source: "delivery-load" });
      emitAppEvent("dispatch.co.updated", { orderId: req.params.id, activatedCo: result.activatedCo, source: "delivery-load" });
    }
    res.json(result);
  } catch (error) {
    if (error.code === "DELIVERY_LOAD_VALIDATION_FAILED") {
      return res.status(409).json({ error: error.message, validation: error.validation });
    }
    next(error);
  }
});

app.get("/api/delivery/fulfillment-jobs/:jobId", async (req, res, next) => {
  try {
    const job = fulfillmentJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Fulfillment job not found" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

async function runReceivingReceipt(orderId, body, currentOperatorId, jobId) {
  updateReceivingJob(jobId, { stage: "validating", message: "Checking confirmed receiving lines." });
  const order = await getReceivableReceivingOrder(orderId);
  updateReceivingJob(jobId, {
    stage: "payload",
    message: `Recording ${order.receivableLines.length} confirmed line(s) locally.`
  });
  const payload = buildItemReceiptPayload(order, order.receivableLines);
  updateReceivingJob(jobId, {
    stage: "local_record",
    message: "Saving local receiving record.",
    payload,
    payloadSummary: {
      receiveLines: payload.item.items.filter((item) => item.itemReceive !== false).length,
      skipLines: payload.item.items.filter((item) => item.itemReceive === false).length
    }
  });
  updateReceivingJob(jobId, {
    stage: "recording",
    message: "Recording receipt locally.",
    itemReceiptId: null,
    itemReceiptTranid: null
  });
  const record = await recordReceivingReceipt(orderId, currentOperatorId, {
    photoDataUrls: body?.photoDataUrls,
    payload,
    response: { localOnly: true },
    itemReceiptId: null,
    itemReceiptTranid: null
  });
  await syncOrderDependenciesForTransferOrder(orderId);
  updateReceivingJob(jobId, {
    stage: "complete",
    message: "Receipt recorded locally.",
    itemReceiptId: record.itemReceiptId,
    itemReceiptTranid: record.itemReceiptTranid
  });
  return record;
}

async function runDeliveryFulfillment(orderId, body, currentOperatorId, jobId) {
    updateFulfillmentJob(jobId, { stage: "validating", message: "Checking packed lines." });
    let order;
    try {
      order = await getFulfillableDeliveryOrder(orderId);
    } catch (error) {
      if (!String(error.message).includes("No packed lines to fulfill.")) throw error;
      updateFulfillmentJob(jobId, {
        stage: "netsuite_check",
        message: "No local pack delta. Checking whether previous NetSuite IF still exists."
      });
      const currentOrder = await getDeliveryOrder(orderId);
      if (!currentOrder?.last_item_fulfillment_id) throw error;
      const existingFulfillment = await fetchItemFulfillmentFromNetSuite(currentOrder.last_item_fulfillment_id);
      if (existingFulfillment) {
        throw new Error(`Already fulfilled by ${existingFulfillment.tranId || existingFulfillment.tranid || currentOrder.last_item_fulfillment_tranid || currentOrder.last_item_fulfillment_id}.`);
      }
      updateFulfillmentJob(jobId, {
        stage: "resetting",
        message: "Previous IF is missing in NetSuite. Resetting local fulfilled qty for resend."
      });
      await resetDeliveryFulfillmentState(orderId, currentOperatorId, "netsuite_if_missing_before_resend");
      order = await getFulfillableDeliveryOrder(orderId);
    }
    updateFulfillmentJob(jobId, {
      stage: "payload",
      message: `Building payload for ${order.fulfillableLines.length} packed line(s).`
    });
    const payload = buildItemFulfillmentPayload(order, order.fulfillableLines);
    updateFulfillmentJob(jobId, {
      stage: "netsuite_post",
      message: "Posting Item Fulfillment to NetSuite.",
      payload,
      payloadSummary: {
        receiveLines: payload.item.items.filter((item) => item.itemReceive !== false && item.itemreceive !== false).length,
        skipLines: payload.item.items.filter((item) => item.itemReceive === false || item.itemreceive === false).length
      }
    });
    const netSuiteResult = order.order_type === "transfer_order"
      ? await transformTransferOrderToItemFulfillment(orderId, payload)
      : await transformSalesOrderToItemFulfillment(orderId, payload);
    updateFulfillmentJob(jobId, {
      stage: "netsuite_read",
      message: "Reading IF number from NetSuite.",
      itemFulfillmentId: netSuiteResult.id
    });
    const fulfillment = netSuiteResult.id ? await fetchItemFulfillmentFromNetSuite(netSuiteResult.id) : null;
    const itemFulfillmentTranid = fulfillment?.tranId || fulfillment?.tranid || fulfillment?.id || null;
    updateFulfillmentJob(jobId, {
      stage: "recording",
      message: itemFulfillmentTranid ? `Recording ${itemFulfillmentTranid} locally.` : "Recording fulfillment locally.",
      itemFulfillmentId: netSuiteResult.id,
      itemFulfillmentTranid
    });
    const record = await recordDeliveryFulfillment(orderId, currentOperatorId, {
      photoDataUrls: body?.photoDataUrls,
      payload,
      response: { netSuiteResult, fulfillment },
      itemFulfillmentId: netSuiteResult.id,
      itemFulfillmentTranid
    });
    const locationId = order.outbound_location_id || body?.locationId;
    updateFulfillmentJob(jobId, {
      stage: "sync_deferred",
      message: "Fulfillment recorded. Order sync is continuing in background.",
      itemFulfillmentId: record.itemFulfillmentId,
      itemFulfillmentTranid: record.itemFulfillmentTranid
    });
    Promise.resolve().then(async () => {
      const syncedOrder = order.order_type === "transfer_order"
        ? await fetchTransferDeliveryOrderFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderFromNetSuite(orderId, locationId);
      if (syncedOrder) {
        if (order.order_type === "transfer_order") await upsertOutboundTransferOrders([syncedOrder]);
        else await upsertSalesOrders([syncedOrder]);
      } else await markOutboundOrderMissing(orderId, { orderFamily: order.order_type });
      const syncedLines = order.order_type === "transfer_order"
        ? await fetchTransferOrderDetailsFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      if (order.order_type === "transfer_order") await upsertOutboundTransferOrderLines(orderId, syncedLines);
      else await upsertSalesOrderLines(orderId, syncedLines);
      await markMissingOutboundOrderLines(orderId, syncedLines.map((line) => line.line_id));
    }).catch((error) => {
      console.error("Delivery fulfillment follow-up sync failed:", error.message);
    });
    return record;
}

app.post("/api/inventory/sync", async (req, res, next) => {
  try {
    const locationIds = req.body?.locationIds || deliveryLocations;
    const rows = await fetchInventoryBalancesFromNetSuite(locationIds);
    const synced = await upsertInventoryBalances(rows);
    const classified = await applyInventoryClassificationRules();
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "inventory",
      action: "inventory.manual_sync",
      details: { locationIds, rows: rows.length, synced, classified }
    });
    res.json({ synced, classified });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/facets", async (req, res, next) => {
  try {
    res.json(await listInventoryFacets({
      locationId: req.query.locationId,
      productType: req.query.productType,
      brand: req.query.brand
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/items", async (req, res, next) => {
  try {
    res.json(await listInventoryItems({
      locationId: req.query.locationId,
      productType: req.query.productType,
      brand: req.query.brand,
      series: req.query.series,
      search: req.query.search
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/classifications", requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listInventoryClassifications({
      search: req.query.search,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/inventory/classifications/:itemId", requireControlAccess, async (req, res, next) => {
  try {
    res.json(await updateInventoryClassification(req.operator.id, req.params.itemId, req.body || {}, {
      allowReturnPolicyChange: operatorHasAnyRole(req.operator, ["admin"])
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cycle-count/draft", async (req, res, next) => {
  try {
    res.json(await getCycleCountDraft(req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cycle-count/records", requireControlAccess, async (req, res, next) => {
  try {
    res.json(await listCycleCountRecords({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cycle-count/lines", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId);
    const itemId = Number(req.body?.itemId);
    if (Number.isInteger(locationId) && locationId > 0 && Number.isInteger(itemId) && itemId > 0) {
      const syncPromise = fetchInventoryBalanceForItemFromNetSuite(itemId, locationId)
        .then(async (rows) => {
          const synced = await upsertInventoryBalances(rows);
          const classified = await applyInventoryClassificationRules();
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync",
            details: { itemId, locationId, rows: rows.length, synced, classified, mode: "before_confirm" }
          });
          return rows;
        })
        .catch(async (error) => {
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync_failed",
            details: { itemId, locationId, error: error.message }
          });
          return [];
        });
      const syncResult = await withTimeout(syncPromise, 2500);
      if (syncResult.timedOut) {
        syncPromise.catch(() => {});
        await writeAudit({
          actorOperatorId: req.operator.id,
          source: "cycle_count",
          action: "cycle_count.confirm_line_inventory_sync_deferred",
          details: { itemId, locationId, timeoutMs: 2500 }
        });
      }
    }
    res.json(await confirmCycleCountLine(req.operator.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cycle-count/submit", async (req, res, next) => {
  try {
    res.json(await submitCycleCount(req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof DispatchPlanEditLeaseError) {
    return sendDispatchPlanEditLeaseError(res, error);
  }
  res.status(error.status || 500).json({
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(Array.isArray(error.conflicts) ? { conflicts: error.conflicts } : {}),
    ...(error.expectedRevision !== undefined ? { expectedRevision: error.expectedRevision } : {}),
    ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
    ...(error.expectedDigest ? { expectedDigest: error.expectedDigest } : {}),
    ...(error.currentDigest ? { currentDigest: error.currentDigest } : {}),
    ...(error.expectedPlanDate ? { expectedPlanDate: error.expectedPlanDate } : {}),
    ...(error.payloadPlanDate ? { payloadPlanDate: error.payloadPlanDate } : {}),
    ...(error.requiredReturnLocation ? { requiredReturnLocation: error.requiredReturnLocation } : {}),
    ...(error.available !== undefined ? { available: error.available } : {}),
    ...(error.sourceLineId !== undefined ? { sourceLineId: error.sourceLineId } : {})
  });
});

export { app, salesPrintRequestIp };

let returnReconciliationRunning = false;
let returnPendingSyncRunning = false;
let scmReconciliationScheduledTickRunning = false;

async function recoverStaleScmReconciliationRuns() {
  return withTransaction(async () => {
    const stale = await query(
      `UPDATE scm_reconciliation_runs
          SET status = 'interrupted',
              error = CASE
                WHEN cancel_requested_at IS NOT NULL
                  THEN COALESCE(NULLIF(cancel_request_note, ''), 'Stopped by an administrator.')
                ELSE COALESCE(NULLIF(error, ''), 'Recovered after a stale reconciliation worker stopped reporting progress.')
              END,
              checkpoint = checkpoint || jsonb_build_object(
                'staleRecoveryAt', now()::text,
                'resumable', true
              ),
              completed_at = now(),
              updated_at = now()
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, started_at, created_at) < now() - interval '30 minutes'
        RETURNING id, status`
    );
    const runIds = stale.rows.map((row) => Number(row.id)).filter(Number.isSafeInteger);
    if (runIds.length) {
      await query(
        `UPDATE scm_reconciliation_run_targets target
            SET status = 'pending',
                error = NULL,
                completed_at = NULL,
                updated_at = now()
           FROM scm_reconciliation_runs run
          WHERE target.run_id = run.id
            AND target.run_id = ANY($1::bigint[])
            AND target.status IN ('pending', 'running')`,
        [runIds]
      );
      console.warn(`Recovered ${runIds.length} stale running SO/PO/TO reconciliation run(s).`);
    }
    return runIds;
  });
}

async function scmReconciliationScheduledTick() {
  if (scmReconciliationScheduledTickRunning) return;
  scmReconciliationScheduledTickRunning = true;
  try {
    await recoverStaleScmReconciliationRuns();
    if (!anyNetSuiteSyncRunning()) {
      const queued = await query(
        `SELECT queued.id
           FROM scm_reconciliation_runs queued
          WHERE queued.status = 'queued'
            AND NOT EXISTS (
              SELECT 1
                FROM scm_reconciliation_runs running
               WHERE running.status = 'running'
            )
          ORDER BY queued.created_at, queued.id
          LIMIT 1`
      );
      if (queued.rows[0]?.id) {
        const completed = await executeScmReconciliationRun(
          Number(queued.rows[0].id),
          {
            operationalSyncRunning: anyNetSuiteSyncRunning
          }
        );
        if (
          completed?.status === "succeeded"
          && completed?.triggerSource === "webhook"
        ) {
          emitAppEvent("dispatch.orders.updated", {
            source: "netsuite-if-ir-webhook-queued",
            orderId: completed.targetOrderId || null,
            orderRef: completed.targetOrderRef || "",
            orderKind: completed.targetOrderKind || "",
            refreshOrderPool: true
          });
        }
        return;
      }
    }
    await scmReconciliationNightlyTick({
      operationalSyncRunning: anyNetSuiteSyncRunning
    });
  } catch (error) {
    console.error("Scheduled SO/PO/TO reconciliation tick failed:", error.message);
  } finally {
    scmReconciliationScheduledTickRunning = false;
  }
}

async function returnPendingSyncTick() {
  if (returnPendingSyncRunning) return;
  returnPendingSyncRunning = true;
  try {
    await processPendingReturnSyncs({ limit: 25 });
  } catch (error) {
    console.error("Scheduled pending return synchronization failed:", error.message);
  } finally {
    returnPendingSyncRunning = false;
  }
}

async function returnReconciliationTick() {
  if (returnReconciliationRunning) return;
  returnReconciliationRunning = true;
  try {
    await reconcileReturnRecords({ limit: 100 });
  } catch (error) {
    console.error("Scheduled return reconciliation failed:", error.message);
  } finally {
    returnReconciliationRunning = false;
  }
}

async function returnCustomerDirectorySyncTick() {
  try {
    await syncReturnCustomerDirectory();
  } catch (error) {
    console.error("Scheduled Return customer directory refresh failed:", error.message);
  }
}

let dispatchV2FollowupTickRunning = false;
let dispatchV2CheckpointRetentionRunning = false;

function dispatchV2PatchOrderRefs(patch = {}) {
  return [...new Set([
    ...(patch.affectedOrderRefs || []),
    ...(patch.operatorAlertRefs || []),
    ...(patch.removedOrderRefs || []),
    ...(patch.assignedOrderRefs || []),
    ...(patch.ungroupedOrderRefs || []),
    ...(patch.group?.orderRefs || []),
    patch.group?.ref,
    patch.split?.sourceOrderRef,
    ...(patch.split?.parts || []).map((part) => part?.refNumber || part?.id),
    patch.sourceOrder?.refNumber || patch.sourceOrder?.id,
    patch.co?.refNumber || patch.co?.id
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

export async function dispatchV2FollowupTick() {
  if (dispatchV2FollowupTickRunning) return { skipped: true, claimed: 0, completed: 0, failed: 0 };
  dispatchV2FollowupTickRunning = true;
  const summary = { skipped: false, claimed: 0, completed: 0, failed: 0 };
  try {
    const rows = await pendingDispatchV2Followups({ limit: 25 });
    summary.claimed = rows.length;
    for (const row of rows) {
      try {
        const plan = await getDispatchPlan(String(row.plan_id || ""));
        if (!plan) throw new Error(`Dispatch plan ${row.plan_id || "unknown"} no longer exists.`);
        const updatedBy = `dispatch-v2:${String(row.command_id || "")}`;
        const completedStages = new Set(Object.entries(row.progress || {})
          .filter(([, state]) => Boolean(state?.completedAt))
          .map(([stage]) => stage));
        if (!completedStages.has("order_dependencies")) {
          await syncOrderDependenciesFromDispatchPlan(plan, {
            allowEstablishedUngroupTargets: row.result?.patch?.safeUngroupTargets || []
          });
          await advanceDispatchV2Followup(row.id, "order_dependencies");
        }
        if (!completedStages.has("co_assignments")) {
          await applyDispatchPlanCoAssignments(plan);
          await advanceDispatchV2Followup(row.id, "co_assignments");
        }
        if (!completedStages.has("scm_schedule")) {
          await syncScmScheduleFromDispatchPlan(plan, { updatedBy });
          await advanceDispatchV2Followup(row.id, "scm_schedule");
        }
        const changedOrderRefs = dispatchV2PatchOrderRefs(row.result?.patch || {});
        if (!completedStages.has("delivery_materialization")) {
          if (plan.status === "confirmed") {
            await applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs: changedOrderRefs });
          }
          await advanceDispatchV2Followup(row.id, "delivery_materialization");
        }
        await completeDispatchV2Followup(row.id);
        summary.completed += 1;
        emitAppEvent("dispatch.plan.followups.completed", {
          planId: plan.id,
          planDate: plan.planDate,
          commandId: row.command_id,
          commandType: row.command_type,
          changedOrderRefs
        });
      } catch (error) {
        summary.failed += 1;
        await failDispatchV2Followup(row.id, error);
        console.error(`Dispatch v2 follow-up failed for command ${row.command_id || "unknown"}:`, error.message);
      }
    }
    return summary;
  } finally {
    dispatchV2FollowupTickRunning = false;
  }
}

export async function dispatchV2CheckpointRetentionTick() {
  if (dispatchV2CheckpointRetentionRunning) return { skipped: true, deleted: 0, checkpointIds: [] };
  dispatchV2CheckpointRetentionRunning = true;
  try {
    return { skipped: false, ...await pruneExpiredDispatchV2Checkpoints({ retentionDays: 7, batchSize: 500 }) };
  } catch (error) {
    console.error("Dispatch v2 checkpoint retention failed:", error.message);
    return { skipped: false, deleted: 0, checkpointIds: [], error: error.message };
  } finally {
    dispatchV2CheckpointRetentionRunning = false;
  }
}

export async function startServer() {
  await recoverInterruptedSyncState();
  await recoverInterruptedPhotoArchive();
  return app.listen(config.port, () => {
    console.log(`MBBS Yard Server listening on ${config.appBaseUrl}`);
    startNetSuiteMirrorWorkers();
    autoSyncTick();
    photoArchiveAutoTick();
    void smartScmAutoTick().catch((error) => console.error("Smart SCM scheduled tick failed:", error));
    setInterval(autoSyncTick, 60000);
    setInterval(photoArchiveAutoTick, 60000);
    setInterval(
      () => void smartScmAutoTick().catch((error) => console.error("Smart SCM scheduled tick failed:", error)),
      Math.max(1, Number(config.smartScm.forecastIntervalMinutes) || 5) * 60000
    );
    setTimeout(() => void returnReconciliationTick(), 30000);
    setTimeout(() => void returnPendingSyncTick(), 5000);
    setTimeout(() => void returnCustomerDirectorySyncTick(), 15000);
    void scmReconciliationScheduledTick();
    setInterval(() => void returnPendingSyncTick(), 60000);
    setInterval(() => void returnReconciliationTick(), 15 * 60 * 1000);
    setInterval(() => void returnCustomerDirectorySyncTick(), 5 * 60 * 1000);
    setInterval(() => void scmReconciliationScheduledTick(), 60000);
    setTimeout(() => void dispatchV2FollowupTick(), 2000);
    setInterval(() => void dispatchV2FollowupTick(), 30000);
    setTimeout(() => void dispatchV2CheckpointRetentionTick(), 60000);
    setInterval(() => void dispatchV2CheckpointRetentionTick(), 24 * 60 * 60 * 1000);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await startServer();
}
