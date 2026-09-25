(function (global) {
  'use strict';
  const RECORD_TYPE = 'driver-customer-signature';
  function scope(job) {
    return JSON.stringify([job.jobId, job.planDate, job.address || job.location,
      [...(job.customerSignaturePrompt?.orderRefs || [])].sort()]);
  }
  async function read(job, context) {
    if (!job?.customerSignaturePrompt || !context.partitionKey) {return null;}
    const records = context.manifest
      ? await global.DriverOfflineDB.getCompatibleDraftPhotos(context.partitionKey, context.manifest, 'job', job.jobId)
      : await global.DriverOfflineDB.getDraftPhotos(context.partitionKey, context.draftKey);
    if (context.manifest) {
      records.push(...await global.DriverOfflineDB.getDraftPhotos(context.partitionKey, `job:bootstrap:${job.jobId}`));
    }
    const record = records.find(photo => photo.recordType === RECORD_TYPE && photo.signatureScope === scope(job));
    if (!record) {return null;}
    return {photo: global.DriverOfflinePhotos.hydrate(record), metadata: record.customerSignature,
      terms: record.signatureTerms};
  }
  async function open(job, context, onSaved = (_saved) => {}) {
    const prompt = job?.customerSignaturePrompt;
    if (!prompt || job.stopType !== 'dropoff') {return;}
    const previous = await read(job, context);
    global.SorSignature.open({
      terms: previous?.terms || prompt.terms,
      orderRefs: prompt.orderRefs,
      initial: previous ? {...previous.metadata, dataUrl: previous.photo.objectUrl} : null,
      onRemove: previous ? async () => {
        await global.DriverOfflineDB.deleteDraftPhoto(previous.photo.photoId);
        onSaved(false);
      } : null,
      onSave: async value => {
        if (!context.partitionKey) {throw new Error('Sign in before saving a signature.');}
        const binary = global.atob(value.dataUrl.split(',')[1]);
        const file = new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], {type: 'image/jpeg'});
        const compressed = await global.DriverOfflinePhotos.compress(file);
        const photoId = global.DriverOfflineDB.createUuid();
        const metadata = {photoId, signedBy: value.signedBy, capturedAt: value.capturedAt,
          termsRevision: previous?.metadata.termsRevision || prompt.revision};
        await global.DriverOfflineDB.saveDraftPhoto(context.partitionKey, context.draftKey, {
          ...compressed, photoId, ordinal: 900, recordType: RECORD_TYPE,
          customerSignature: metadata, signatureTerms: previous?.terms || prompt.terms, signatureScope: scope(job)
        }, {replacePhotoId: previous?.photo.photoId || ''});
        onSaved(true);
      }
    });
  }
  async function onlinePayload(saved) {
    if (!saved) {return undefined;}
    const imageDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('The saved signature could not be read.'));
      reader.readAsDataURL(saved.photo.blob);
    });
    return {...saved.metadata, imageDataUrl};
  }
  global.SorDriverSignature = {read, open, onlinePayload};
})(window);
