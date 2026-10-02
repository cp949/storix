import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { DataSource } from 'typeorm';
import type { BackupJob } from '../../src/jobs/backup.job.js';
import type { RestoreJob } from '../../src/jobs/restore.job.js';
import { generateNamespaceId, NAMESPACE_ID_MAX_LENGTH } from '../../src/common/namespace-id.js';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsSnapshotRepository } from '../../src/persistence/vfs-snapshot.repository.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { VfsChangeEventEntity } from '../../src/persistence/entities/vfs-change-event.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadStagingCleanupEntity } from '../../src/persistence/entities/vfs-upload-staging-cleanup.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';

/** 시나리오가 시드하고 읽는 모든 저장소가 필요로 하는 엔티티. */
export const BACKUP_RESTORE_ENTITIES = [
  NamespaceEntity,
  VfsNodeEntity,
  BlobEntity,
  VfsChangeEventEntity,
  VfsChangeFeedStateEntity,
  IdempotencyKeyEntity,
  VfsTrashEntity,
  VfsTrashEntryEntity,
  VfsSnapshotEntity,
  VfsSnapshotEntryEntity,
  VfsUploadSessionEntity,
  VfsUploadPartEntity,
  VfsUploadStagingCleanupEntity,
  VfsUploadUsageEntity,
];

/** 12자 최대 prefix. `-`·`_`가 들어 있어 C collation과 locale collation의 정렬이 갈린다. */
const MAX_PREFIX = 'a_b-c9z0y1x2';

/** 백업·복구 시나리오가 드라이버별 인프라에서 받는 입력. */
export interface BackupRestoreNamespaceIdContext {
  /** 시드를 넣고 백업을 뜨는 원본 DB. */
  readonly sourceDs: () => DataSource;

  /** 시드 object를 넣고 백업이 읽는 원본 스토리지. */
  readonly sourceStorage: () => BlobStorage;

  /** 복구가 쓰는, 마이그레이션만 적용된 빈 대상 스토리지. */
  readonly targetStorage: () => BlobStorage;

  /** 복구 전 대상 DB. 마이그레이션만 적용한 빈 상태다. */
  readonly targetDs: () => DataSource;

  /** 원본 DB 설정으로 만든 BackupJob. */
  readonly createBackupJob: (backupRootDir: string) => BackupJob;

  /** 대상 DB·스토리지 설정으로 만든 RestoreJob. */
  readonly createRestoreJob: (backupDir: string) => RestoreJob;

  /** 복구 뒤 대상 DB를 다시 열어 돌려준다. 파일 DB는 덮어쓴 파일을 새 연결로 읽는다. */
  readonly reopenTarget: () => Promise<DataSource>;

  /** 지금 ID들이 PostgreSQL의 `COLLATE "C"`를 가져야 하는지 여부. */
  readonly isPostgres: boolean;
}

interface SeededNamespace {
  readonly id: string;
  readonly name: string;
  readonly blobKeys: ReadonlyMap<string, Buffer>;

  /** 진행 중 upload session의 creation key. PostgreSQL에서는 uuid 열이다. */
  readonly creationKey: string;
}

interface DatabaseState {
  /** 테이블별 행. 열 순서와 행 순서에 영향받지 않도록 JSON 문자열로 정렬해 둔다. */
  readonly rows: Record<string, string[]>;

  /** 열 정의와 collation. 드라이버별 카탈로그 질의 결과다. */
  readonly schema: string[];
}

/** bigint를 문자열로 바꿔 행을 직렬화한다. */
function serializeRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** 사용자 테이블 이름을 돌려준다. */
async function listTables(ds: DataSource): Promise<string[]> {
  const rows =
    ds.options.type === 'postgres'
      ? ((await ds.query(
          `SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )) as { name: string }[])
      : ((await ds.query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )) as { name: string }[]);
  return rows.map((row) => row.name).sort();
}

/** 모든 테이블의 행과 스키마를 비교 가능한 값으로 읽는다. */
async function captureDatabaseState(ds: DataSource): Promise<DatabaseState> {
  const rows: Record<string, string[]> = {};
  for (const table of await listTables(ds)) {
    const found = (await ds.query(`SELECT * FROM "${table}"`)) as Record<string, unknown>[];
    rows[table] = found.map(serializeRow).sort();
  }
  const schema =
    ds.options.type === 'postgres'
      ? (
          (await ds.query(
            `SELECT table_name, column_name, data_type, character_maximum_length, collation_name, is_nullable
             FROM information_schema.columns WHERE table_schema = 'public'
             ORDER BY table_name, column_name`,
          )) as Record<string, unknown>[]
        ).map(serializeRow)
      : (
          (await ds.query(
            `SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`,
          )) as Record<string, unknown>[]
        ).map(serializeRow);
  return { rows, schema };
}

/** DB 안에서 직접 센 값과 저장된 counter가 일치하는지 확인한다. */
async function expectCountersMatchRows(ds: DataSource, namespaceId: string): Promise<void> {
  const namespace = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
  const nodes = await ds.getRepository(VfsNodeEntity).findBy({ namespaceId });
  const live = nodes.filter((node) => node.parentId !== null);
  expect(String(namespace.liveNodeCount)).toBe(String(live.length));
  for (const directory of nodes.filter((node) => node.type === 'DIRECTORY')) {
    const files = live.filter((node) => node.parentId === directory.id && node.type === 'FILE').length;
    expect(String(directory.childFileCount)).toBe(String(files));
  }
}

function createRepositories(ds: DataSource) {
  const blobs = new BlobRepository(ds);
  return {
    provisioning: new NamespaceProvisioningRepository(ds),
    nodes: new VfsNodeRepository(
      ds.getRepository(NamespaceEntity),
      ds.getRepository(VfsNodeEntity),
      ds.getRepository(BlobEntity),
      ds,
      blobs,
      new ConfigService(),
    ),
    snapshots: new VfsSnapshotRepository(ds, blobs),
    uploads: new VfsUploadSessionRepository(ds),
  };
}

const UPLOAD_CAPS = {
  global: { maxStagedBytes: 1_000_000n, maxActiveSessions: 100 },
  namespace: { maxStagedBytes: 1_000_000n, maxActiveSessions: 100 },
};

function uploadInput(namespaceId: string, creationKey: string) {
  const now = new Date();
  return {
    id: randomUUID(),
    namespaceId,
    scope: 'backup-restore',
    creationKey,
    fingerprint: 'a'.repeat(64),
    targetPath: '/upload.bin',
    sizeBytes: '10',
    mimeType: 'application/octet-stream',
    conditionType: 'ABSENT' as const,
    conditionRevision: null,
    fileExpiresInSeconds: null,
    partSizeBytes: 10,
    partCount: 1,
    now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    maxExpiresAt: new Date(now.getTime() + 7 * 86_400_000),
  };
}

/**
 * namespace 하나에 디렉터리·파일·휴지통·snapshot·진행 중 upload session을 만든다.
 * FILE은 실제 스토리지 object와 Blob 행을 함께 둔다.
 */
async function seedNamespace(
  ds: DataSource,
  storage: BlobStorage,
  id: string,
  name: string,
): Promise<SeededNamespace> {
  const repositories = createRepositories(ds);
  await repositories.provisioning.createWithRoot(id, name);
  await ds.getRepository(NamespaceEntity).update({ id }, { trashEnabled: true });
  const root = (await repositories.nodes.getRoot(id))!;
  await repositories.nodes.ensureDirectory(id, root.id, ['docs'], false);
  await repositories.nodes.ensureDirectory(id, root.id, ['docs', 'deep'], false);

  const blobKeys = new Map<string, Buffer>();
  async function addFile(parentSegments: string[], fileName: string): Promise<void> {
    const parent =
      parentSegments.length === 0
        ? root
        : (await repositories.nodes.resolvePath(id, root.id, parentSegments))!;
    const content = Buffer.from(`${id}:${[...parentSegments, fileName].join('/')}`);
    const storageKey = `blobs/${randomUUID().slice(0, 2)}/${randomUUID()}`;
    await storage.put(storageKey, Readable.from(content));
    blobKeys.set(storageKey, content);
    const blob = await ds.getRepository(BlobEntity).save({
      namespaceId: id,
      storageKey,
      size: String(content.length),
      mimeType: 'text/plain',
      sha256: '0'.repeat(64),
      referenceCount: 1,
    });
    await ds.getRepository(VfsNodeEntity).save({
      namespaceId: id,
      parentId: parent.id,
      name: fileName,
      type: 'FILE',
      blobId: blob.id,
      size: String(content.length),
      mimeType: 'text/plain',
    });
    await ds.getRepository(NamespaceEntity).increment({ id }, 'liveFileByteCount', content.length);
    await ds.getRepository(NamespaceEntity).increment({ id }, 'liveNodeCount', 1);
    await ds
      .getRepository(VfsNodeEntity)
      .createQueryBuilder()
      .update(VfsNodeEntity)
      .set({
        childFileCount: () => 'child_file_count + 1',
        version: () => 'version',
        updatedAt: () => 'updated_at',
      })
      .where('id = :parentId', { parentId: parent.id })
      .execute();
  }
  await addFile([], 'a.txt');
  await addFile(['docs'], 'b.txt');
  await addFile(['docs', 'deep'], 'c.txt');
  await addFile([], 'trashed.txt');
  await addFile([], 'snapshotted.txt');

  const trashId = await repositories.nodes.removeNode(id, root.id, ['trashed.txt'], false, 100);
  expect(trashId).not.toBeNull();
  await repositories.nodes.withMutation(id, root.id, async (tx) => {
    const rows = await repositories.nodes.captureSnapshotRows(tx, ['snapshotted.txt'], 100);
    return repositories.snapshots.capture(tx, { kind: 'FILE', sourcePath: '/snapshotted.txt', rows });
  });
  const creationKey = randomUUID();
  const session = await repositories.uploads.createSession(uploadInput(id, creationKey), UPLOAD_CAPS);
  expect(session.kind).toBe('created');

  return { id, name, blobKeys, creationKey };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFilesRecursively(full)));
    else found.push(full);
  }
  return found;
}

/**
 * 최대 길이 prefix ID와 기존 형식 ID가 섞인 DB를 백업해 빈 대상에 복구하는 시나리오를 등록한다.
 * Postgres와 SQLite 실행 파일이 같은 본문을 공유한다.
 */
export function registerBackupRestoreNamespaceIdTests(
  context: BackupRestoreNamespaceIdContext,
  backupRootDir: () => string,
): void {
  const maxId = `${MAX_PREFIX}_${randomUUID().replaceAll('-', '')}`;
  const otherMaxId = `${MAX_PREFIX.replace('_', '-')}_${randomUUID().replaceAll('-', '')}`;
  const ids = {
    max: maxId,
    otherMax: otherMaxId,
    legacy: randomUUID(),
    hex32: generateNamespaceId(),
  };
  const seeded: SeededNamespace[] = [];
  let before: DatabaseState;
  let after: DatabaseState;
  let restoredDs: DataSource;
  let backupDir: string;

  beforeAll(async () => {
    expect(maxId).toHaveLength(NAMESPACE_ID_MAX_LENGTH);
    expect(otherMaxId).toHaveLength(NAMESPACE_ID_MAX_LENGTH);
    expect(ids.legacy).toHaveLength(36);
    expect(ids.hex32).toHaveLength(32);
    for (const [key, id] of Object.entries(ids)) {
      seeded.push(
        await seedNamespace(
          context.sourceDs(),
          context.sourceStorage(),
          id,
          `backup-id-${key.toLowerCase()}`,
        ),
      );
    }
    before = await captureDatabaseState(context.sourceDs());

    const backup = await context.createBackupJob(backupRootDir()).run();
    backupDir = backup.backupDir;
    await context.createRestoreJob(backupDir).run();
    restoredDs = await context.reopenTarget();
    after = await captureDatabaseState(restoredDs);
  }, 240000);

  it('복구한 DB의 모든 테이블 행이 백업 시점과 같다', () => {
    expect(Object.keys(after.rows).sort()).toEqual(Object.keys(before.rows).sort());
    for (const table of Object.keys(before.rows)) {
      expect({ table, rows: after.rows[table] }).toEqual({ table, rows: before.rows[table] });
    }
  });

  it('복구한 DB의 열 정의와 collation이 원본과 같다', () => {
    expect(after.schema).toEqual(before.schema);
  });

  it('namespace ID가 36자·32자·45자 문자열 그대로 복구된다', async () => {
    const stored = await restoredDs.getRepository(NamespaceEntity).find();
    const storedIds = stored.map((namespace) => namespace.id);
    for (const id of Object.values(ids)) expect(storedIds).toContain(id);
    expect(Math.max(...storedIds.map((id) => id.length))).toBe(NAMESPACE_ID_MAX_LENGTH);
  });

  it('최대 길이 ID의 vfs_upload_usage 파생 키와 진행 중 session이 복구된다', async () => {
    const rows = (await restoredDs.query(
      `SELECT id, namespace_id, active_sessions FROM vfs_upload_usage WHERE namespace_id = ${
        context.isPostgres ? '$1' : '?'
      }`,
      [ids.max],
    )) as { id: string; namespace_id: string; active_sessions: string | number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`ns:${ids.max}`);
    expect(rows[0].id).toHaveLength(NAMESPACE_ID_MAX_LENGTH + 3);
    expect(String(rows[0].active_sessions)).toBe('1');
  });

  it('복구한 namespace의 counter가 실제 행 수와 일치한다', async () => {
    for (const { id } of seeded) await expectCountersMatchRows(restoredDs, id);
  });

  it('ID 정렬이 바이트 순서(C collation)와 같다', async () => {
    const rows = (await restoredDs.query('SELECT id FROM namespace ORDER BY id')) as { id: string }[];
    const bytewise = rows.map((row) => row.id).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(rows.map((row) => row.id)).toEqual(bytewise);
    if (context.isPostgres) {
      const collations = (await restoredDs.query(
        `SELECT table_name, column_name, collation_name FROM information_schema.columns
         WHERE table_schema = 'public' AND (column_name = 'namespace_id' OR (table_name = 'namespace' AND column_name = 'id'))
           AND data_type = 'character varying'`,
      )) as { table_name: string; column_name: string; collation_name: string | null }[];
      expect(collations.length).toBeGreaterThan(1);
      expect(collations.filter((row) => row.collation_name !== 'C')).toEqual([]);
    }
  });

  it('백업 디렉터리 경로에 namespace ID가 들어가지 않고 경로 요소가 255바이트 이하다', async () => {
    const files = await listFilesRecursively(backupDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const relative = path.relative(backupDir, file);
      for (const id of Object.values(ids)) expect(relative).not.toContain(id);
      for (const segment of relative.split(path.sep)) {
        expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(255);
      }
    }
  });

  it('스토리지 object가 대상 스토리지에 같은 내용으로 복구된다', async () => {
    for (const { blobKeys } of seeded) {
      for (const [key, content] of blobKeys) {
        const restored = await readAll(await context.targetStorage().get(key));
        expect(restored.equals(content)).toBe(true);
      }
    }
  });

  it('복구한 최대 길이 namespace에서 파일 생성과 upload session 재생이 동작한다', async () => {
    const repositories = createRepositories(restoredDs);
    const root = (await repositories.nodes.getRoot(ids.max))!;
    const beforeNamespace = await restoredDs.getRepository(NamespaceEntity).findOneByOrFail({ id: ids.max });

    const touched = await repositories.nodes.touchFile(ids.max, root.id, ['after-restore.txt'], false, {
      storageKey: `blobs/00/${randomUUID()}`,
      size: '0',
      mimeType: 'application/octet-stream',
      sha256: '0'.repeat(64),
      encryptionIv: null,
    });
    expect(touched.kind).toBe('created');
    const afterNamespace = await restoredDs.getRepository(NamespaceEntity).findOneByOrFail({ id: ids.max });
    expect(String(afterNamespace.liveNodeCount)).toBe(String(Number(beforeNamespace.liveNodeCount) + 1));
    await expectCountersMatchRows(restoredDs, ids.max);

    const replay = await repositories.uploads.createSession(
      uploadInput(ids.max, seeded.find((namespace) => namespace.id === ids.max)!.creationKey),
      UPLOAD_CAPS,
    );
    // 복구 전 session과 creation key·fingerprint가 같아 새 session을 만들지 않고 재생된다.
    expect(replay.kind).toBe('replay');
  });
}
