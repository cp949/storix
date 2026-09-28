import { assertPathSegments } from '../vfs/path-resolver.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import type { EntityManager } from 'typeorm';
import type {
  VfsNodeRecord,
  VfsNodeMatch,
  NameFilterMode,
  FindRecursiveRow,
  NamedDescendant,
} from './vfs-node.repository.types.js';

export function assertSubtreeDestinationPaths(
  sourceId: string,
  finalSegments: string[],
  descendants: readonly NamedDescendant[],
): void {
  const children = new Map<string, NamedDescendant[]>();
  for (const row of descendants) {
    if (row.id === sourceId) continue;
    if (row.parent_id === null) throw new Error('subtree descendant parent 누락');
    const siblings = children.get(row.parent_id) ?? [];
    siblings.push(row);
    children.set(row.parent_id, siblings);
  }

  const queue: Array<{ id: string; segments: string[] }> = [{ id: sourceId, segments: finalSegments }];
  for (let head = 0; head < queue.length; head += 1) {
    const parent = queue[head];
    assertPathSegments(parent.segments);
    for (const child of children.get(parent.id) ?? []) {
      queue.push({ id: child.id, segments: [...parent.segments, child.name] });
    }
  }
}

export function toRecord(entity: VfsNodeEntity): VfsNodeRecord {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    blobId: entity.blobId,
    size: entity.size,
    mimeType: entity.mimeType,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    version: entity.version,
    expiresAt: entity.expiresAt,
  };
}

// raw SQL 경로는 TypeORM의 엔티티 하이드레이션을 안 거치므로, SQLite
// 드라이버가 돌려주는 "2026-09-08 23:02:01" 같은 공백 구분·타임존 없는
// 문자열을 Date로 그냥 넘기면 V8이 로컬 타임존으로 해석해버린다(Postgres는
// 이미 Date 객체를 돌려주므로 이 문제가 없다). TypeORM의
// AbstractSqliteDriver.prepareHydratedValue가 엔티티 경로에서 하는 것과
// 같은 보정을 적용해 항상 UTC로 해석되게 한다.
export function parseSqlTimestamp(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }
  let normalized = value;
  if (/^\d\d\d\d-\d\d-\d\d \d\d:\d\d/.test(normalized)) {
    normalized = normalized.replace(' ', 'T');
  }
  if (/^\d\d\d\d-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(normalized)) {
    normalized += 'Z';
  }
  return new Date(normalized);
}

export function toMatch(row: FindRecursiveRow): VfsNodeMatch {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    blobId: row.blob_id,
    size: row.size,
    mimeType: row.mime_type,
    createdAt: parseSqlTimestamp(row.created_at),
    updatedAt: parseSqlTimestamp(row.updated_at),
    version: row.version,
    expiresAt: row.expires_at === null ? null : parseSqlTimestamp(row.expires_at),
    relativeSegments: row.path_segments.split('/'),
  };
}

// 트랜잭션의 DB 현재 시각. SQLite CURRENT_TIMESTAMP는 타임존 없는 문자열이라 UTC로 보정한다.
export async function readDbNow(manager: EntityManager): Promise<Date> {
  const raw = (await manager.query('SELECT CURRENT_TIMESTAMP AS now')) as Array<{ now: Date | string }>;
  return parseSqlTimestamp(raw[0].now);
}

export function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildLikePattern(mode: NameFilterMode, value: string): string {
  const escaped = escapeLikeValue(value);
  switch (mode) {
    case 'contains':
      return `%${escaped}%`;
    case 'prefix':
      return `${escaped}%`;
    case 'suffix':
      return `%${escaped}`;
    default:
      return escaped;
  }
}

export function joinSegments(segments: string[]): string {
  return `/${segments.join('/')}`;
}

// segment 배열에 대한 사전식(lexicographic) 전역 순서. 한쪽이 다른 쪽의 prefix이면
// 더 짧은 쪽이 먼저 온다. joinSegments로 합친 path 문자열 비교는 이 순서의 유효한
// 대용물이 아니므로(예: '/a' <= '/a.b/x'는 true지만 '/a.b' <= '/a/y'도 true — './'이
// '/'보다 ASCII상 앞이라 발생하는 모순) 트리 구조상의 순서가 필요한 곳에서는 반드시
// 이 함수처럼 segment 단위로 비교해야 한다.
export function compareSegments(a: readonly string[], b: readonly string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}
