interface SorSignatureValue { signedBy: string; capturedAt: string; dataUrl: string; }
interface SorSignatureMetadata { photoId: string; signedBy: string; capturedAt: string; termsRevision: number; }
interface SorSignatureDialogOptions {
  terms?: string;
  orderRefs?: string[];
  preview?: boolean;
  initial?: {dataUrl: string; signedBy?: string} | null;
  onSave?: (value: SorSignatureValue) => Promise<void>;
  onRemove?: (() => Promise<void>) | null;
}
interface SorDraftPhoto {
  photoId: string;
  recordType: string;
  signatureScope?: string;
  signatureTerms?: string;
  customerSignature?: SorSignatureMetadata;
  blob?: Blob;
  blobBytes?: ArrayBuffer;
  objectUrl?: string;
}
interface Window {
  SorSignature: {open(options: SorSignatureDialogOptions): void; isOpen(): boolean};
  SorAdmin: {mount(root: HTMLElement, request: (path: string, options?: RequestInit) => Promise<any>): Promise<void>};
  SorDriverSignature: {
    read(job: any, context: any): Promise<{photo: SorDraftPhoto; metadata: SorSignatureMetadata; terms: string} | null>;
    open(job: any, context: any, onSaved?: (saved: boolean) => void): Promise<void>;
    onlinePayload(saved: any): Promise<{imageDataUrl: unknown} & SorSignatureMetadata | undefined>;
  };
  DriverOfflineDB: {
    getCompatibleDraftPhotos(partition: string, manifest: any, kind: string, suffix: string): Promise<SorDraftPhoto[]>;
    getDraftPhotos(partition: string, draft: string): Promise<SorDraftPhoto[]>;
    deleteDraftPhoto(id: string): Promise<void>;
    createUuid(): string;
    saveDraftPhoto(partition: string, draft: string, photo: SorDraftPhoto & Record<string, any>, options?: Record<string, any>): Promise<SorDraftPhoto>;
  };
  DriverOfflinePhotos: {
    hydrate(photo: SorDraftPhoto): SorDraftPhoto;
    compress(file: Blob): Promise<Record<string, any>>;
  };
}
