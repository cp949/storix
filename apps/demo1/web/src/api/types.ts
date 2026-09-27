export type DemoUser = "alice" | "bob";

export interface FileEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "FILE" | "DIRECTORY";
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

export interface PresignedDownload {
  readonly url: string;
  readonly expiresAt: string;
}

export interface PublicLink {
  readonly url: string;
  readonly publicPath: string;
}

export interface UploadSessionCreated {
  readonly sessionId: string;
  readonly state: "OPEN";
  readonly partSizeBytes: number;
  readonly partCount: number;
  readonly expiresAt: string;
  readonly maxExpiresAt: string;
}

export interface UploadSessionStatus extends Omit<
  UploadSessionCreated,
  "state"
> {
  readonly state:
    "OPEN" | "FINALIZING" | "COMPLETED" | "CANCELLED" | "EXPIRED" | "FAILED";
  readonly path: string;
  readonly sizeBytes: string;
  readonly mimeType: string;
  readonly parts: readonly {
    readonly index: number;
    readonly sizeBytes: string;
  }[];
}

export interface UploadSessionCompleteResult {
  readonly resource: FileEntry & { readonly revision: string };
  readonly affectedRevisions: readonly {
    readonly path: string;
    readonly revision: string;
  }[];
}

export interface UploadPartResult {
  readonly index: number;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly replayed: boolean;
}

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}
