/**
 * 데이터셋 적재 SQL 생성. 모든 행은 Postgres 안의 `generate_series`로 만든다.
 * 하네스 프로세스는 ID를 보관하지 않고 번호 구간(chunk)만 순회한다.
 * 행 구성은 `NamespaceProvisioningRepository.createWithRoot`(namespace + root vfs_node + 생성 receipt),
 * `VfsNodeRepository`의 change feed 기록, `NamespaceQuotaService`의 관리 receipt,
 * `NamespaceDeletionRepository`의 삭제 receipt와 같은 모양이다.
 * 같은 모양인지는 `verify-fidelity` 명령이 API 표본과 대조한다.
 */
import type { DatasetSpec } from './spec.ts';
import { validateSpec } from './spec.ts';

/** 번호 구간 `[from, to]`(양 끝 포함). */
export interface Range {
  readonly from: number;
  readonly to: number;
}

/** `1..total`을 `size` 크기 구간으로 나눈다. */
export function chunkRanges(total: number, size: number): Range[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('total은 0 이상의 정수여야 한다');
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('size는 1 이상의 정수여야 한다');
  const ranges: Range[] = [];
  for (let from = 1; from <= total; from += size) ranges.push({ from, to: Math.min(total, from + size - 1) });
  return ranges;
}

function assertValid(spec: DatasetSpec): void {
  const errors = validateSpec(spec);
  if (errors.length > 0) throw new Error(`데이터셋 명세 오류: ${errors.join('; ')}`);
}

function ref(spec: DatasetSpec): string {
  return `'${new Date(spec.refTime).toISOString()}'::timestamptz`;
}

/** 번호 `i`에서 결정적 UUID를 만드는 SQL 식. */
function uuidOf(spec: DatasetSpec, kind: string, ...parts: string[]): string {
  const tail = parts.map((part) => ` || ':' || ${part}`).join('');
  // RFC 4122 형식(version 4, variant 8)으로 맞춰야 서버의 엄격한 UUID 검증을 통과한다.
  return `overlay(overlay(md5('${spec.seed}:${kind}'${tail}) placing '4' from 13) placing '8' from 17)::uuid`;
}

function blobStorageKey(idExpr: string): string {
  return `'blobs/' || substr(${idExpr}::text, 1, 2) || '/' || ${idExpr}::text`;
}

/** `{"accessPolicy":"PRIVATE","encryptionPolicy":"NONE","name":"<name>"}`의 sha256. `canonicalJsonHash`와 같다. */
function createRequestHash(nameExpr: string): string {
  return `encode(sha256(convert_to('{"accessPolicy":"PRIVATE","encryptionPolicy":"NONE","name":"' || ${nameExpr} || '"}', 'UTF8')), 'hex')`;
}

function isoTs(expr: string): string {
  return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function namespaceBody(
  spec: DatasetSpec,
  idExpr: string,
  nameExpr: string,
  tsExpr: string,
  status: string,
  limitExpr = `'${spec.defaults.quotaLimitBytes}'`,
): string {
  const d = spec.defaults;
  return `jsonb_build_object(
      'id', ${idExpr}::text, 'name', ${nameExpr}, 'encryptionPolicy', 'NONE', 'accessPolicy', 'PRIVATE',
      'status', '${status}', 'createdAt', ${isoTs(tsExpr)}, 'updatedAt', ${isoTs(tsExpr)},
      'limits', jsonb_build_object('maxFileSizeBytes', '${d.maxFileSizeBytes}'),
      'quota', jsonb_build_object('limitBytes', ${limitExpr}, 'usedBytes', '0',
        'trash', jsonb_build_object('enabled', false, 'retainedNodeCount', 0, 'maxRetainedNodes', ${d.maxRetainedTrashNodes})))`;
}

/**
 * ACTIVE namespace `from..to`의 적재 SQL. 한 번의 트랜잭션이다.
 * namespace·root·생성 receipt는 모든 번호에, 나머지는 활동·만료·orphan 조건에 맞는 번호에만 만든다.
 */
export function activeChunkSql(spec: DatasetSpec, range: Range): string {
  assertValid(spec);
  const { from, to } = range;
  const nsId = uuidOf(spec, 'ns', 'i');
  const created = `(${ref(spec)} - interval '40 days' - (i % 1000) * interval '1 minute')`;
  const activeFilter = `i % ${spec.activeEvery} = 0`;
  const series = `generate_series(${from}, ${to}) AS i`;
  const fileBlobId = uuidOf(spec, 'blob', 'i', 'k');
  const orphanBlobId = uuidOf(spec, 'orphan', 'i', 'k');
  const docsId = uuidOf(spec, 'docs', 'i');
  const hash = createRequestHash(`'ns-' || i`);
  // 활동 namespace의 이벤트. 만료 namespace는 선두 e개가 60일 전, 막힌(blocked) namespace는 선두만 유효하고 뒤가 90일 전이다.
  const recent = `${ref(spec)} - interval '1 day' + e * interval '1 second'`;
  const old = `${ref(spec)} - interval '60 days' + e * interval '1 second'`;
  // 막힌 namespace의 만료 이벤트는 만료 namespace의 선두보다 더 오래돼, 시각 순 탐색이 이것들을 먼저 만난다.
  const blockedOld = `${ref(spec)} - interval '90 days' + e * interval '1 second'`;
  const blockedTime =
    spec.blockedEvery === 0 ? 'FALSE' : `i % ${spec.blockedEvery} = 0 AND i % ${spec.expiredEvery} <> 0`;
  const eventTime = `CASE
      WHEN i % ${spec.expiredEvery} = 0 AND e <= ${spec.expiredEventsPerDue} THEN ${old}
      WHEN ${blockedTime} AND e > 1 AND e <= ${spec.expiredEventsPerDue + 1} THEN ${blockedOld}
      ELSE ${recent} END`;
  return `BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO namespace (id, name, encryption_policy, access_policy, status, created_at, updated_at, live_file_byte_count)
SELECT ${nsId}, 'ns-' || i, 'NONE', 'PRIVATE', 'ACTIVE', ${created}, ${created},
  CASE WHEN ${activeFilter} THEN ${spec.filesPerActive * spec.fileSizeBytes} ELSE 0 END
FROM ${series};
INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count, zero_since, created_at)
SELECT ${fileBlobId}, ${nsId}, ${blobStorageKey(fileBlobId)}, ${spec.fileSizeBytes}, 'application/octet-stream',
  encode(sha256(convert_to('${spec.seed}:content:' || i || ':' || k, 'UTF8')), 'hex'), 1, NULL, ${created}
FROM ${series}, generate_series(1, ${spec.filesPerActive}) AS k WHERE ${activeFilter};
INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count, zero_since, created_at)
SELECT ${orphanBlobId}, ${nsId}, ${blobStorageKey(orphanBlobId)}, ${spec.fileSizeBytes}, 'application/octet-stream',
  encode(sha256(convert_to('${spec.seed}:orphan-content:' || i || ':' || k, 'UTF8')), 'hex'), 0,
  ${ref(spec)} - interval '60 days', ${created}
FROM ${series}, generate_series(1, ${spec.orphanBlobsPerDue}) AS k WHERE i % ${spec.orphanEvery} = 0;
INSERT INTO vfs_node (id, namespace_id, parent_id, type, name, created_at, updated_at)
SELECT ${uuidOf(spec, 'root', 'i')}, ${nsId}, NULL, 'DIRECTORY', '', ${created}, ${created}
FROM ${series};
INSERT INTO vfs_node (id, namespace_id, parent_id, type, name, created_at, updated_at)
SELECT ${docsId}, ${nsId}, ${uuidOf(spec, 'root', 'i')}, 'DIRECTORY', 'docs', ${created}, ${created}
FROM ${series} WHERE ${activeFilter};
INSERT INTO vfs_node (id, namespace_id, parent_id, type, name, blob_id, size, mime_type, created_at, updated_at)
SELECT ${uuidOf(spec, 'file', 'i', 'k')}, ${nsId}, ${docsId}, 'FILE', 'file-' || k || '.bin', ${fileBlobId},
  ${spec.fileSizeBytes}, 'application/octet-stream', ${created}, ${created}
FROM ${series}, generate_series(1, ${spec.filesPerActive}) AS k WHERE ${activeFilter};
INSERT INTO idempotency_key (key, request_hash, response_status, response_body, created_at)
SELECT 'scale-create-' || i, ${hash}, 201,
  ${namespaceBody(spec, nsId, `'ns-' || i`, created, 'ACTIVE')}, ${created}
FROM ${series};
INSERT INTO idempotency_key (key, request_hash, response_status, response_body, created_at)
SELECT encode(sha256(convert_to(${nsId}::text, 'UTF8') || '\\x00'::bytea || convert_to('namespace-quota', 'UTF8') || '\\x00'::bytea
    || convert_to('scale-quota-' || i || '-' || r, 'UTF8')), 'hex'),
  encode(sha256(convert_to('{"maxTotalLogicalBytes":"' || (1073741824 + r) || '","namespaceId":"' || ${nsId}::text || '"}', 'UTF8')), 'hex'),
  200, ${namespaceBody(spec, nsId, `'ns-' || i`, created, 'ACTIVE', `((1073741824 + r)::text)`)}, ${created}
FROM ${series}, generate_series(1, ${spec.managementReceiptsPerActive}) AS r WHERE ${activeFilter};
INSERT INTO vfs_change_feed_state (namespace_id, last_sequence, pruned_through, has_checkpoint, signing_secret)
SELECT ${nsId}, ${spec.eventsPerActive}, 0, true, md5('${spec.seed}:secret:a:' || i) || md5('${spec.seed}:secret:b:' || i)
FROM ${series} WHERE ${activeFilter};
INSERT INTO vfs_change_event (namespace_id, sequence, operation_id, operation_index, operation_count, kind, node_id, node_type, path, previous_path, revision, occurred_at)
SELECT ${nsId}, e, ${uuidOf(spec, 'op', 'i', 'e')}, 0, 1, 'created', ${uuidOf(spec, 'file', 'i', `((e - 1) % ${spec.filesPerActive} + 1)`)},
  'FILE', '/docs/file-' || ((e - 1) % ${spec.filesPerActive} + 1) || '.bin', NULL, 'scale-rev-' || e, ${eventTime}
FROM ${series}, generate_series(1, ${spec.eventsPerActive}) AS e WHERE ${activeFilter};
COMMIT;
`;
}

/** DELETED namespace `from..to`(번호는 1..deletedNamespaces)의 적재 SQL. */
export function deletedChunkSql(spec: DatasetSpec, range: Range): string {
  assertValid(spec);
  const { from, to } = range;
  const nsId = uuidOf(spec, 'dns', 'i');
  const created = `(${ref(spec)} - interval '80 days' - (i % 1000) * interval '1 minute')`;
  const completed = `(${ref(spec)} - interval '30 days')`;
  const series = `generate_series(${from}, ${to}) AS i`;
  const hash = createRequestHash(`'deleted-' || i`);
  return `BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO namespace (id, name, encryption_policy, access_policy, status, created_at, updated_at)
SELECT ${nsId}, 'deleted-' || i, 'NONE', 'PRIVATE', 'DELETED', ${created}, ${completed}
FROM ${series};
INSERT INTO idempotency_key (key, request_hash, response_status, response_body, created_at)
SELECT 'scale-create-deleted-' || i, ${hash}, 201,
  ${namespaceBody(spec, nsId, `'deleted-' || i`, created, 'ACTIVE')}, ${created}
FROM ${series};
INSERT INTO namespace_deletion (namespace_id, phase, requested_at, updated_at, completed_at, blocked_reason)
SELECT ${nsId}, 'COMPLETED', ${completed} - interval '1 hour', ${completed}, ${completed}, NULL
FROM ${series};
INSERT INTO namespace_deletion_receipt (namespace_id, key_hash, response_status, response_body, created_at)
SELECT ${nsId}, encode(sha256(convert_to('scale-delete-' || i, 'UTF8')), 'hex'), 202,
  jsonb_build_object('namespaceId', ${nsId}::text, 'status', 'DELETING'), ${completed} - interval '1 hour'
FROM ${series};
COMMIT;
`;
}

/** 적재 뒤 통계를 갱신한다. 측정 전 같은 계획이 선택되도록 한다. */
export const ANALYZE_SQL = 'ANALYZE;';

/** 규모 검증용 행 수 질의. 결과 열은 `ExpectedCounts` 필드와 대응한다. */
export const COUNT_SQL = `SELECT
  (SELECT count(*) FROM namespace) AS namespace,
  (SELECT count(*) FROM namespace WHERE status = 'ACTIVE') AS "activeNamespaces",
  (SELECT count(*) FROM namespace WHERE status = 'DELETED') AS "deletedNamespaces",
  (SELECT count(*) FROM vfs_node) AS "vfsNode",
  (SELECT count(*) FROM blob) AS blob,
  (SELECT count(*) FROM blob WHERE reference_count = 0) AS "orphanBlobs",
  (SELECT count(*) FROM idempotency_key) AS "idempotencyKey",
  (SELECT count(*) FROM vfs_change_feed_state) AS "changeFeedState",
  (SELECT count(*) FROM vfs_change_event) AS "changeEvent",
  (SELECT count(*) FROM vfs_change_event WHERE occurred_at < now() - interval '30 days') AS "expiredChangeEvents",
  (SELECT count(*) FROM vfs_change_event WHERE sequence = 1 AND occurred_at < now() - interval '30 days') AS "dueNamespaces",
  (SELECT count(DISTINCT e.namespace_id) FROM vfs_change_event e
     WHERE e.sequence > 1 AND e.occurred_at < now() - interval '30 days'
       AND EXISTS (SELECT 1 FROM vfs_change_event h WHERE h.namespace_id = e.namespace_id AND h.sequence = 1
         AND h.occurred_at >= now() - interval '30 days')) AS "blockedNamespaces",
  (SELECT count(*) FROM namespace_deletion) AS "namespaceDeletion"`;
