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
