import { VfsNodeRecord } from '../../persistence/vfs-node.repository.js';
import { VfsNodeType } from '../../persistence/entities/vfs-node.entity.js';
import { encodeRevision } from '../revision.js';

export interface VfsNodeResponseDto {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly size: number | null;
  readonly mimeType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly expiresAt: string | null;
}

export function toNodeResponse(record: VfsNodeRecord, path: string): VfsNodeResponseDto {
  return {
    id: record.id,
    path,
    name: record.name,
    type: record.type,
    size: record.size === null ? null : Number(record.size),
    mimeType: record.mimeType,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
  };
}

// 412 body의 current 전용 shape. 공통 노드 필드에 충돌 시점의 revision(`r1.`)을 더한다.
// 소비자가 충돌 시점 ETag를 만들 수 있도록 노드 식별과 version을 묶은 토큰이며,
// 다른 공통 노드 응답의 VfsNodeResponseDto에는 revision을 넣지 않는다.
export interface VfsPreconditionCurrentDto extends VfsNodeResponseDto {
  readonly revision: string;
}

export function toPreconditionCurrent(record: VfsNodeRecord, path: string): VfsPreconditionCurrentDto {
  return { ...toNodeResponse(record, path), revision: encodeRevision(record) };
}

// 조건부 콘텐츠 생성·교체 성공 resource. receipt에 고정되므로 재생 시에도 성공 상태의 revision을 반환한다.
export interface VfsConditionalContentResourceDto extends VfsNodeResponseDto {
  readonly revision: string;
}

export function toConditionalContentResponse(
  record: VfsNodeRecord,
  path: string,
): VfsConditionalContentResourceDto {
  return { ...toNodeResponse(record, path), revision: encodeRevision(record) };
}

// GET /fs/stat 전용 shape. 같은 읽기 트랜잭션에서 읽은 노드의 revision과 참조 Blob SHA-256을 더한다.
// DIRECTORY의 sha256은 null이다.
export interface VfsStatResponseDto extends VfsNodeResponseDto {
  readonly revision: string;
  readonly sha256: string | null;
}

export function toStatResponse(
  record: VfsNodeRecord,
  path: string,
  sha256: string | null,
): VfsStatResponseDto {
  return { ...toNodeResponse(record, path), revision: encodeRevision(record), sha256 };
}
