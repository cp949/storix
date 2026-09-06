import { VfsNodeRecord } from '../../persistence/vfs-node.repository.js';
import { VfsNodeType } from '../../persistence/entities/vfs-node.entity.js';

export interface VfsNodeResponseDto {
  readonly path: string;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly size: number | null;
  readonly mimeType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export function toNodeResponse(record: VfsNodeRecord, path: string): VfsNodeResponseDto {
  return {
    path,
    name: record.name,
    type: record.type,
    size: record.size === null ? null : Number(record.size),
    mimeType: record.mimeType,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  };
}
