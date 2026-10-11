// 원본 FILE·Blob metadata와 target 사전조건을 짧은 읽기 transaction에서 고정한다.
// 경로·ZIP 이름의 구조 검증은 호출자 책임이다. capture는 참조 수를 변경하지 않는다.
// DB 시각 deadline과 grace 설정 검사는 실행 중 원본 보존의 증명이 아니다.
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import {
  VfsArchiveDeadlineExceededError,
  VfsArchiveInvalidRequestError,
  VfsArchiveInvalidRevisionError,
  VfsArchivePreconditionFailedError,
  VfsArchiveTooLargeError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
} from '../vfs/vfs.errors.js';
import { decodeRevision, encodeRevision } from '../vfs/revision.js';
import { toPreconditionCurrent } from '../vfs/dto/node-response.dto.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { classifyPersistenceOperation } from './persistence-failure.js';

/** 요청에서 지정한 원본 FILE과 ZIP 내부 이름이다. */
export interface ArchiveSourceEntry {
  /** namespace 안의 원본 FILE ID다. */
  readonly id: string;

  /** ZIP 내부 상대 경로다. */
  readonly name: string;

  /** 선택된 원본 FILE의 조건부 revision이다. */
  readonly revision?: string;
}

/** capture할 원본과 출력 경로를 나타낸다. */
export interface ArchiveSourceCommand {
  /** root 기준 출력 FILE 경로다. */
  readonly target: string;

  /** 요청 순서가 유지되는 ZIP 항목이다. */
  readonly entries: readonly ArchiveSourceEntry[];
}

/** DB snapshot에서 고정한 원본 FILE metadata다. */
export interface CapturedArchiveEntry {
  /** 원본 FILE ID다. */
  readonly id: string;

  /** ZIP 내부 상대 경로다. */
  readonly name: string;

  /** snapshot에서 확인한 원본 revision이다. */
  readonly revision: string;

  /** 원본 콘텐츠의 Blob ID다. */
  readonly blobId: string;

  /** storage 내부에서 콘텐츠를 찾는 key다. */
  readonly storageKey: string;

  /** 복호화 후 예상하는 원본 byte 수다. */
  readonly plaintextBytes: bigint;

  /** 복호화된 원본 전체의 SHA-256이다. */
  readonly sha256: string;

  /** namespace가 암호화된 경우 사용하는 IV다. */
  readonly encryptionIv: Buffer | null;

  /** ZIP DOS timestamp 입력으로 사용하는 원본 갱신 시각이다. */
  readonly updatedAt: Date;
}

/** 같은 DB snapshot에서 읽은 archive 실행 입력이다. */
export interface ArchiveSourceCapture {
  /** 원본 namespace ID다. */
  readonly namespaceId: string;

  /** 해당 namespace의 VFS root ID다. */
  readonly rootId: string;

  /** capture 시각에 고정한 실행 종료 시각이다. */
  readonly deadlineAt: Date;

  /** 중복 요청 항목을 포함한 평문 원본 합계다. */
  readonly sourceBytes: bigint;

  /** 요청 순서대로 capture한 원본 metadata다. */
  readonly entries: readonly CapturedArchiveEntry[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_CHUNK_SIZE = 400;

/** archive 원본을 읽기 전용 DB snapshot으로 고정한다. */
@Injectable()
export class ArchiveSourceRepository {
  /** 저장소의 DataSource를 받는다. */
  constructor(private readonly dataSource: DataSource) {}

  /** 원본, target 사전조건, 실행 deadline을 한 snapshot에서 capture한다. */
  @classifyPersistenceOperation
  async capture(
    namespaceId: string,
    rootId: string,
    command: ArchiveSourceCommand,
    limits: { readonly maxEntries: number; readonly maxSourceBytes: bigint; readonly maxSeconds: number },
  ): Promise<ArchiveSourceCapture> {
    const work = async (manager: EntityManager): Promise<ArchiveSourceCapture> => {
      const [{ now }] = (await manager.query(
        this.isSqlite
          ? "SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS now"
          : 'SELECT clock_timestamp() AS now',
      )) as { now: Date | string }[];
      const dbNow = now instanceof Date ? now : new Date(`${now}${now.endsWith('Z') ? '' : 'Z'}`);
      const deadlineAt = new Date(dbNow.getTime() + limits.maxSeconds * 1000);

      if (command.entries.length === 0) throw new VfsArchiveInvalidRequestError();
      if (command.entries.length > limits.maxEntries) throw new VfsArchiveTooLargeError();
      const ids = command.entries.map(({ id }) => {
        if (!UUID_PATTERN.test(id)) throw new VfsArchiveInvalidRequestError();
        return id.toLowerCase();
      });

      const namespace = await manager.getRepository(NamespaceEntity).findOneBy({ id: namespaceId });
      if (!namespace || namespace.status !== 'ACTIVE') throw new VfsNamespaceNotFoundError(namespaceId);
      const root = await manager
        .getRepository(VfsNodeEntity)
        .findOneBy({ id: rootId, namespaceId, parentId: IsNull() });
      if (!root) throw new VfsNamespaceNotFoundError(namespaceId);

      // target 경로 충돌은 source ID·revision 오류보다 먼저 반환한다.
      await this.assertTarget(manager, namespaceId, rootId, command.target);

      const nodesById = new Map<string, VfsNodeEntity>();
      const nodeRepository = manager.getRepository(VfsNodeEntity);
      for (let offset = 0; offset < ids.length; offset += ID_CHUNK_SIZE) {
        const rows = await nodeRepository.find({
          where: { namespaceId, id: In(ids.slice(offset, offset + ID_CHUNK_SIZE)) },
        });
        for (const row of rows) nodesById.set(row.id.toLowerCase(), row);
      }

      const blobRepository = manager.getRepository(BlobEntity);
      const blobIds = [
        ...new Set([...nodesById.values()].flatMap((node) => (node.blobId ? [node.blobId] : []))),
      ];
      const blobsById = new Map<string, BlobEntity>();
      for (let offset = 0; offset < blobIds.length; offset += ID_CHUNK_SIZE) {
        const rows = await blobRepository.find({
          where: { namespaceId, id: In(blobIds.slice(offset, offset + ID_CHUNK_SIZE)) },
        });
        for (const row of rows) blobsById.set(row.id, row);
      }

      const output: CapturedArchiveEntry[] = [];
      let sourceBytes = 0n;
      for (let archiveEntry = 0; archiveEntry < command.entries.length; archiveEntry += 1) {
        const requested = command.entries[archiveEntry];
        const node = nodesById.get(requested.id.toLowerCase());
        if (!node) throw new VfsNodeNotFoundError('/');
        if (node.type !== 'FILE') throw new VfsArchiveInvalidRequestError();
        if (requested.revision !== undefined) {
          let expected: { id: string; version: number };
          try {
            expected = decodeRevision(requested.revision);
          } catch {
            throw new VfsArchiveInvalidRevisionError(archiveEntry);
          }
          if (expected.id !== node.id.toLowerCase() || expected.version !== node.version) {
            throw new VfsArchivePreconditionFailedError(
              requested.name,
              toPreconditionCurrent(node, requested.name),
              archiveEntry,
            );
          }
        }
        if (!node.blobId || node.size === null)
          throw new Error('FILE node에 Blob 또는 size가 없음 — 데이터 일관성 위반');
        const blob = blobsById.get(node.blobId);
        if (!blob) throw new Error('FILE node가 참조하는 Blob이 없음 — 데이터 일관성 위반');
        const plaintextBytes = BigInt(node.size);
        sourceBytes += plaintextBytes;
        if (sourceBytes > limits.maxSourceBytes) throw new VfsArchiveTooLargeError();
        output.push({
          id: node.id,
          name: requested.name,
          revision: encodeRevision(node),
          blobId: blob.id,
          storageKey: blob.storageKey,
          plaintextBytes,
          sha256: blob.sha256,
          encryptionIv: blob.encryptionIv,
          updatedAt: node.updatedAt,
        });
      }
      return { namespaceId, rootId, deadlineAt, sourceBytes, entries: output };
    };
    return this.isSqlite
      ? this.dataSource.transaction(work)
      : this.dataSource.transaction('REPEATABLE READ', work);
  }

  /** 최종 mutation transaction에서 DB wall-clock deadline을 검사한다. */
  @classifyPersistenceOperation
  async assertDeadline(manager: EntityManager, deadlineAt: Date): Promise<void> {
    const [{ expired }] = (await manager.query(
      this.isSqlite
        ? "SELECT julianday('now') >= julianday(?) AS expired"
        : 'SELECT clock_timestamp() >= $1::timestamptz AS expired',
      [deadlineAt.toISOString()],
    )) as { expired: boolean | number }[];
    if (expired === true || expired === 1) throw new VfsArchiveDeadlineExceededError();
  }

  private get isSqlite(): boolean {
    return isSqliteDataSource(this.dataSource.options);
  }

  private async assertTarget(
    manager: EntityManager,
    namespaceId: string,
    rootId: string,
    target: string,
  ): Promise<void> {
    const segments = target.split('/').filter(Boolean);
    if (segments.length === 0) throw new VfsArchiveInvalidRequestError();
    const nodeRepository = manager.getRepository(VfsNodeEntity);
    let parentId = rootId;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const parent = await nodeRepository.findOneBy({ namespaceId, parentId, name: segments[index] });
      if (!parent) throw new VfsNodeNotFoundError('/' + segments.slice(0, index + 1).join('/'));
      if (parent.type !== 'DIRECTORY')
        throw new VfsNotDirectoryError('/' + segments.slice(0, index + 1).join('/'));
      parentId = parent.id;
    }
    const targetNode = await nodeRepository.findOneBy({ namespaceId, parentId, name: segments.at(-1)! });
    if (targetNode) {
      throw new VfsArchivePreconditionFailedError(target, toPreconditionCurrent(targetNode, target));
    }
  }
}
