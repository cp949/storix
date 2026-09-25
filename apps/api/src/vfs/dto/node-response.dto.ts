import { VfsNodeRecord } from '../../persistence/vfs-node.repository.js';
import { VfsNodeType } from '../../persistence/entities/vfs-node.entity.js';
import { encodeRevision } from '../revision.js';

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

// 412 body의 current 전용 shape. stat 응답 필드에 충돌 시점의 revision(`r1.`)을 더한다.
// 소비자가 충돌 시점 ETag를 만들 수 있도록 노드 식별과 version을 묶은 토큰이며,
// stat 등 다른 응답의 VfsNodeResponseDto에는 revision을 넣지 않는다.
export interface VfsPreconditionCurrentDto extends VfsNodeResponseDto {
  readonly revision: string;
}

export function toPreconditionCurrent(record: VfsNodeRecord, path: string): VfsPreconditionCurrentDto {
  return { ...toNodeResponse(record, path), revision: encodeRevision(record) };
}
