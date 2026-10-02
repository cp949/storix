/**
 * API로 만든 표본과 SQL 적재 표본의 행 모양을 대조한다.
 * 같은 이름의 namespace를 한쪽은 API로, 다른 쪽은 SQL 적재로 만들고 id·시각·내용 해시를 뺀 값이 같은지 본다.
 * 일치하지 않는 항목은 문장으로 돌려준다. 차이가 알려진 항목(`revision` 문자열 형식 등)은 비교에서 제외한다.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { deepStrictEqual } from 'node:assert/strict';
import { activeNamespaceId } from './dataset/ids.ts';
import { migrate } from './dataset/seed.ts';
import { defaultSpec } from './dataset/spec.ts';
import { activeChunkSql, deletedChunkSql } from './dataset/sql.ts';
import { databaseEnv, ensurePostgres, ensureStorage, storageEnv } from './infra/containers.ts';
import { createDatabase, dropDatabase, execSql, queryAll, queryOne } from './infra/psql.ts';
import { runGc } from './measure/gc.ts';
import { WORK_DIR } from './paths.ts';
import { buildApiEnv, findFreePort, startApi } from './measure/server.ts';

const API_KEY = 'fidelity-api-key';
const ADMIN_KEY = 'fidelity-admin-key';
const DB_SQL = 'storix_scale_fidelity_sql';
const DB_API = 'storix_scale_fidelity_api';

/**
 * 비교에서 빼는 열. id·시각·내용 해시·저장 키처럼 실행마다 달라지는 값과,
 * 표본 구성이 다른 값(SQL 표본은 파일 5개·API 표본은 1개라 `live_file_byte_count`, quota를 바꾼 쪽의 `max_total_logical_bytes`,
 * 변경 횟수에 따라 늘어나는 `version`·sequence 계열 열)이다. 파일당 크기·카운터 규칙은 `fileBytesCheck`가 따로 본다.
 */
const VOLATILE = [
  'last_sequence',
  'sequence',
  'operation_index',
  'operation_count',
  'requested_at',
  'completed_at',
  'live_file_byte_count',
  'max_total_logical_bytes',
  'version',
  'id',
  'namespace_id',
  'parent_id',
  'blob_id',
  'node_id',
  'operation_id',
  'created_at',
  'updated_at',
  'occurred_at',
  'zero_since',
  'storage_key',
  'sha256',
  'revision',
  'signing_secret',
  'name',
  'path',
  'key',
  'request_hash',
];

async function shape(database: string, table: string, where: string): Promise<unknown> {
  const rows = await queryAll<{ row: unknown }>(
    database,
    `SELECT to_jsonb(t) - ARRAY[${VOLATILE.map((c) => `'${c}'`).join(',')}] AS row FROM ${table} t WHERE ${where} ORDER BY 1 LIMIT 1`,
  );
  return rows[0]?.row ?? null;
}

function stripBody(body: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const key of ['id', 'createdAt', 'updatedAt', 'name', 'namespaceId']) delete clone[key];
  return clone;
}

/** 한 항목을 비교하고 다르면 메시지를 problems에 넣는다. */
function expectSame(problems: string[], label: string, fromSql: unknown, fromApi: unknown): void {
  try {
    deepStrictEqual(fromSql, fromApi);
  } catch {
    problems.push(`${label}\n  SQL : ${JSON.stringify(fromSql)}\n  API : ${JSON.stringify(fromApi)}`);
  }
}

/** 표본을 만들어 비교한다. 문제 목록이 비어 있으면 일치한다. */
export async function verifyFidelity(progress: (message: string) => void): Promise<string[]> {
  ensurePostgres();
  ensureStorage();
  const problems: string[] = [];
  const spec = {
    ...defaultSpec(20, new Date().toISOString(), 'fidelity'),
    orphanEvery: 10,
    expiredEvery: 10,
    deletedNamespaces: 2,
  };
  for (const db of [DB_SQL, DB_API]) {
    createDatabase(db);
    migrate(db);
  }
  try {
    progress('SQL 표본 적재');
    await execSql(DB_SQL, activeChunkSql(spec, { from: 1, to: spec.namespaces }));
    await execSql(DB_SQL, deletedChunkSql(spec, { from: 1, to: spec.deletedNamespaces }));

    progress('API 표본 생성');
    const port = await findFreePort();
    const apiEnv = buildApiEnv({
      port,
      apiKey: API_KEY,
      adminKey: ADMIN_KEY,
      databaseEnv: databaseEnv(DB_API),
      storageEnv: storageEnv(),
    });
    const auth = { Authorization: `Bearer ${API_KEY}` };
    const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
    let apiId = '';
    let deletedId = '';
    const first = await startApi({ env: apiEnv, port, label: 'fidelity-1' });
    try {
      const create = async (name: string, key: string): Promise<string> => {
        const response = await fetch(`${first.baseUrl}/api/v2/namespaces`, {
          method: 'POST',
          headers: {
            ...auth,
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({ name }),
        });
        if (response.status !== 201) throw new Error(`namespace 생성 실패: ${response.status}`);
        return ((await response.json()) as { id: string }).id;
      };
      apiId = await create('ns-10', 'scale-create-10');
      deletedId = await create('deleted-1', 'scale-create-deleted-1');
      const quota = await fetch(`${first.baseUrl}/api/v2/admin/namespaces/${apiId}/quota`, {
        method: 'PATCH',
        headers: {
          ...admin,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'scale-quota-10-1',
        },
        body: JSON.stringify({ maxTotalLogicalBytes: '1073741825' }),
      });
      if (quota.status !== 200) throw new Error(`quota 변경 실패: ${quota.status}`);
      const del = await fetch(`${first.baseUrl}/api/v2/admin/namespaces/${deletedId}/delete`, {
        method: 'POST',
        headers: { ...admin, 'Idempotency-Key': 'scale-delete-1' },
      });
      if (del.status !== 202) throw new Error(`삭제 접수 실패: ${del.status}`);
    } finally {
      await first.stop();
    }
    // change-feed capability는 기본 비활성이다. namespace가 만들어진 뒤 설정에 적어 다시 기동한다.
    const capabilityPath = path.join(WORK_DIR, 'fidelity-capabilities.json');
    writeFileSync(
      capabilityPath,
      JSON.stringify({
        globalAllowedCapabilities: ['change-feed'],
        namespaceAllowedCapabilities: { [apiId]: ['change-feed'] },
      }),
    );
    const capabilityEnv = {
      ...apiEnv,
      STORIX_VFS_CAPABILITIES_CONFIG_PATH: capabilityPath,
    };
    const second = await startApi({
      env: capabilityEnv,
      port,
      label: 'fidelity-2',
    });
    try {
      // 변경 기록 checkpoint를 만든 뒤 파일을 올려 change event를 만든다.
      const checkpoint = await fetch(`${second.baseUrl}/api/v2/namespaces/${apiId}/fs/changes`, {
        headers: auth,
      });
      if (checkpoint.status !== 200) throw new Error(`checkpoint 실패: ${checkpoint.status}`);
      const upload = await fetch(
        `${second.baseUrl}/api/v2/namespaces/${apiId}/fs/content?path=${encodeURIComponent('/docs/file-1.bin')}&parents=true`,
        {
          method: 'POST',
          headers: {
            ...auth,
            'Content-Type': 'application/octet-stream',
            'Idempotency-Key': 'fidelity-upload',
            'X-Mutation-Scope': 'fidelity',
          },
          body: Buffer.alloc(1024, 7),
        },
      );
      if (upload.status !== 201) throw new Error(`업로드 실패: ${upload.status}`);
    } finally {
      await second.stop();
    }
    progress('삭제 정리를 GC로 완료');
    for (let attempt = 0; attempt < 6; attempt++) {
      await runGc({
        env: {
          ...apiEnv,
          STORIX_GC_MIN_INTERVAL: '1',
          STORIX_ORPHAN_GRACE_PERIOD: '1',
        },
        label: `fidelity-gc-${attempt}`,
        timeoutMs: 120_000,
      });
      const state = await queryOne<{ status: string }>(
        DB_API,
        `SELECT status FROM namespace WHERE name = 'deleted-1'`,
      );
      if (state.status === 'DELETED') break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const sqlId = activeNamespaceId(spec, 10);
    const sqlWhere = `namespace_id = '${sqlId}'`;
    const apiWhere = `namespace_id = '${apiId}'`;
    expectSame(
      problems,
      'namespace',
      await shape(DB_SQL, 'namespace', `name = 'ns-10'`),
      await shape(DB_API, 'namespace', `name = 'ns-10'`),
    );
    expectSame(
      problems,
      'root vfs_node',
      await shape(DB_SQL, 'vfs_node', `${sqlWhere} AND parent_id IS NULL`),
      await shape(DB_API, 'vfs_node', `${apiWhere} AND parent_id IS NULL`),
    );
    expectSame(
      problems,
      'docs 디렉터리 vfs_node',
      await shape(DB_SQL, 'vfs_node', `${sqlWhere} AND type = 'DIRECTORY' AND parent_id IS NOT NULL`),
      await shape(DB_API, 'vfs_node', `${apiWhere} AND type = 'DIRECTORY' AND parent_id IS NOT NULL`),
    );
    expectSame(
      problems,
      'FILE vfs_node',
      await shape(DB_SQL, 'vfs_node', `${sqlWhere} AND type = 'FILE' AND name = 'file-1.bin'`),
      await shape(DB_API, 'vfs_node', `${apiWhere} AND type = 'FILE'`),
    );
    expectSame(
      problems,
      'blob(참조 1)',
      await shape(DB_SQL, 'blob', `${sqlWhere} AND reference_count = 1`),
      await shape(DB_API, 'blob', `${apiWhere} AND reference_count = 1`),
    );
    expectSame(
      problems,
      'change feed state',
      await shape(DB_SQL, 'vfs_change_feed_state', sqlWhere),
      await shape(DB_API, 'vfs_change_feed_state', apiWhere),
    );
    expectSame(
      problems,
      'change event(FILE created)',
      await shape(DB_SQL, 'vfs_change_event', `${sqlWhere} AND node_type = 'FILE' AND kind = 'created'`),
      await shape(DB_API, 'vfs_change_event', `${apiWhere} AND node_type = 'FILE' AND kind = 'created'`),
    );

    const sqlCreate = await queryOne<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }>(
      DB_SQL,
      `SELECT request_hash, response_status, response_body FROM idempotency_key WHERE key = 'scale-create-10'`,
    );
    const apiCreate = await queryOne<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }>(
      DB_API,
      `SELECT request_hash, response_status, response_body FROM idempotency_key WHERE key = 'scale-create-10'`,
    );
    expectSame(problems, '생성 receipt request_hash', sqlCreate.request_hash, apiCreate.request_hash);
    expectSame(
      problems,
      '생성 receipt status·body(id·시각·name 제외)',
      {
        status: sqlCreate.response_status,
        body: stripBody(sqlCreate.response_body),
      },
      {
        status: apiCreate.response_status,
        body: stripBody(apiCreate.response_body),
      },
    );

    // quota receipt: key와 hash는 namespace id가 들어가므로 같은 공식을 각 database의 id로 계산해 대조한다.
    const quotaKey = (id: string): string =>
      createHash('sha256').update(`${id}\0namespace-quota\0scale-quota-10-1`, 'utf8').digest('hex');
    const sqlQuota = await queryOne<{ n: number }>(
      DB_SQL,
      `SELECT count(*) AS n FROM idempotency_key WHERE key = '${quotaKey(sqlId)}'`,
    );
    const apiQuota = await queryOne<{
      response_status: number;
      response_body: unknown;
    }>(DB_API, `SELECT response_status, response_body FROM idempotency_key WHERE key = '${quotaKey(apiId)}'`);
    expectSame(problems, '관리 receipt key 공식(SQL 표본에 같은 공식의 key가 존재)', Number(sqlQuota.n), 1);
    expectSame(problems, '관리 receipt status', 200, apiQuota.response_status);
    const sqlQuotaBody = await queryOne<{ response_body: unknown }>(
      DB_SQL,
      `SELECT response_body FROM idempotency_key WHERE key = '${quotaKey(sqlId)}'`,
    );
    expectSame(
      problems,
      '관리 receipt body 모양(값 제외 키 집합)',
      Object.keys(stripBody(sqlQuotaBody.response_body) as object).sort(),
      Object.keys(stripBody(apiQuota.response_body) as object).sort(),
    );

    expectSame(
      problems,
      'DELETED namespace',
      await shape(DB_SQL, 'namespace', `name = 'deleted-1'`),
      await shape(DB_API, 'namespace', `name = 'deleted-1'`),
    );
    expectSame(
      problems,
      'namespace_deletion',
      await shape(DB_SQL, 'namespace_deletion', `phase = 'COMPLETED'`),
      await shape(DB_API, 'namespace_deletion', `phase = 'COMPLETED'`),
    );
    const receiptRow = async (db: string): Promise<unknown> => {
      const row = (await shape(db, 'namespace_deletion_receipt', 'true')) as {
        response_body: Record<string, unknown>;
      } | null;
      return row === null ? null : { ...row, response_body: stripBody(row.response_body) };
    };
    expectSame(problems, 'namespace_deletion_receipt', await receiptRow(DB_SQL), await receiptRow(DB_API));
    const fileBytes = (
      await queryOne<{ size: string }>(
        DB_API,
        `SELECT size FROM blob WHERE ${apiWhere} AND reference_count = 1`,
      )
    ).size;
    expectSame(problems, '파일당 크기(SQL 표본 fileSizeBytes)', spec.fileSizeBytes, Number(fileBytes));
    expectSame(
      problems,
      'namespace.live_file_byte_count(API는 파일 1개)',
      1024,
      Number(
        (
          await queryOne<{ v: string }>(
            DB_API,
            `SELECT live_file_byte_count AS v FROM namespace WHERE id = '${apiId}'`,
          )
        ).v,
      ),
    );
    const leftover = await queryOne<{ nodes: number; events: number }>(
      DB_API,
      `SELECT (SELECT count(*) FROM vfs_node WHERE namespace_id = '${deletedId}') AS nodes, (SELECT count(*) FROM vfs_change_event WHERE namespace_id = '${deletedId}') AS events`,
    );
    expectSame(
      problems,
      '삭제 완료 namespace에 남는 node·event 수(SQL 표본은 0)',
      { nodes: 0, events: 0 },
      { nodes: Number(leftover.nodes), events: Number(leftover.events) },
    );
  } finally {
    dropDatabase(DB_SQL);
    dropDatabase(DB_API);
  }
  return problems;
}
