import base from '../eslint.mbt.config.js';
export default [{ ...base[1], files: ['**/*.{js,mjs}'], languageOptions: {
  ...base[1].languageOptions, globals: { ...base[1].languageOptions.globals,
    dispatchSessionId: 'readonly', localStorage: 'readonly', document: 'readonly',
    currentPlanDate: 'writable', currentPlan: 'writable', compactCurrentPlan: 'readonly',
    dispatchConfig: 'writable', dispatchSetupLoaded: 'writable', dispatchPlannerSnapshotState: 'writable',
    orders: 'writable', normalizeOrder: 'readonly', orderCatalog: 'writable', trucks: 'writable', fleet: 'writable',
    drivers: 'writable', lastAcknowledgedPlanState: 'writable', dispatchPlanWireState: 'readonly',
    planEditMode: 'writable', planEditLeaseToken: 'writable', planEditLease: 'writable',
    selectedLoadId: 'writable', loadPreviewOpen: 'writable', localPlanDirty: 'writable', activeOrderType: 'writable',
    render: 'readonly', PointerEvent: 'readonly', dispatchOrderHydrationPromises: 'readonly', DataTransfer: 'readonly',
    DragEvent: 'readonly', requestAnimationFrame: 'readonly', findLoad: 'readonly', routeNotice: 'readonly',
    saveInFlight: 'readonly', saveQueued: 'readonly', forceSaveCurrentPlan: 'readonly'
  }
} }];
