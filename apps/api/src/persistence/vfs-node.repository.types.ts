import { EntityManager } from 'typeorm';
import { AccessPolicy, EncryptionPolicy } from './entities/namespace.entity.js';
import { VfsNodeType } from './entities/vfs-node.entity.js';
import type { ChangeFeedNodeState } from './vfs-change-feed-journal.js';

export interface VfsNodeRecord {
  readonly id: string;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly blobId: string | null;
  readonly size: string | null;
  readonly mimeType: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

// FILE 콘텐츠 조회에 필요한 참조 Blob 정보. sha256은 복호화한 원본 전체 바이트 기준이다.
export interface VfsContentBlobRef {
  readonly storageKey: string;
  readonly encryptionIv: Buffer | null;
  readonly sha256: string;
}

export interface NamespaceResourceLimits {
  readonly maxFileSizeBytes: string | null;
  readonly maxSyncDeleteNodes: number | null;
  readonly maxSyncCopyNodes: number | null;
  readonly encryptionPolicy: EncryptionPolicy;
  readonly accessPolicy: AccessPolicy;
}

export interface VfsNodeMatch extends VfsNodeRecord {
  readonly relativeSegments: string[];
}

export type NameFilterMode = 'exact' | 'contains' | 'prefix' | 'suffix';

export interface FindFilter {
  readonly name?: { readonly mode: NameFilterMode; readonly value: string };
  readonly type?: VfsNodeType;
}

export interface BlobData {
  readonly storageKey: string;
  readonly size: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly encryptionIv: Buffer | null;
}

export interface RestorableBlob {
  readonly blobId: string;
  readonly size: string;
  readonly mimeType: string;
}

export type PutFileOutcome =
  | { readonly kind: 'created'; readonly node: VfsNodeRecord }
  | { readonly kind: 'replaced'; readonly node: VfsNodeRecord };

export interface MutationTx {
  readonly manager: EntityManager;
  readonly namespaceId: string;
  readonly rootId: string;
  readonly changed: Map<string, { path: string; increment: boolean }>;
  readonly feedBefore: Map<string, ChangeFeedNodeState> | null;
  liveFileByteDelta: bigint;
  logicalByteDelta: bigint;
}

export interface SnapshotSourceRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly revision: string;
  readonly relativePath: string;
  readonly blobId: string | null;
  readonly size: string | null;
  readonly mimeType: string | null;
}

export interface AffectedRevision {
  readonly path: string;
  readonly revision: string;
}

export type ContentPrecondition = { readonly ifAbsent: true } | { readonly ifRevision: string };

export interface FindRecursiveRow {
  readonly id: string;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly blob_id: string | null;
  readonly size: string | null;
  readonly mime_type: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly version: number;
  readonly path_segments: string;
}

export interface CopySourceRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly type: VfsNodeType;
  readonly name: string;
  readonly blob_id: string | null;
  readonly size: string | null;
  readonly mime_type: string | null;
}

export interface NamedDescendant {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
}
