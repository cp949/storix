export interface FileEntry {
  readonly path: string;
  readonly name: string;
  readonly type: 'FILE' | 'DIRECTORY';
  readonly size: number | null;
  readonly mimeType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface EntryPage {
  readonly items: FileEntry[];
  readonly nextCursor: string | null;
}

export interface UploadMetadata {
  readonly mimeType?: string;
  readonly contentLength?: number;
}

export interface PresignedDownload {
  readonly url: string;
  readonly expiresAt: string;
}

export interface PublicLink {
  readonly url: string;
  readonly publicPath: string;
}

export type UploadSessionCondition = { readonly ifAbsent: true } | { readonly ifRevision: string };

export type UploadSessionCreateRequest = {
  readonly path: string;
  readonly sizeBytes: string;
  readonly mimeType: string;
  readonly sha256?: string;
} & UploadSessionCondition;

export interface UploadSessionCreated {
  readonly sessionId: string;
  readonly state: 'OPEN';
  readonly partSizeBytes: number;
  readonly partCount: number;
  readonly expiresAt: string;
  readonly maxExpiresAt: string;
}

export interface UploadSessionStatus extends Omit<UploadSessionCreated, 'state'> {
  readonly state: 'OPEN' | 'FINALIZING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  readonly path: string;
  readonly sizeBytes: string;
  readonly mimeType: string;
  readonly condition: UploadSessionCondition;
  readonly parts: readonly { readonly index: number; readonly sizeBytes: string }[];
  readonly result?: UploadSessionCompleteResult;
  readonly failure?: { readonly code: 'VFS_CHECKSUM_MISMATCH' };
}

export interface UploadPartResult {
  readonly index: number;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly replayed: boolean;
}

export interface UploadSessionCompleteResult {
  readonly resource: FileEntry & { readonly revision: string };
  readonly affectedRevisions: readonly { readonly path: string; readonly revision: string }[];
}

export interface UploadSessionCompletion {
  readonly status: 200 | 201;
  readonly body: UploadSessionCompleteResult;
}
