// extract 원본 FILE·Blob metadata와 대상 DIRECTORY 사전조건을 짧은 읽기 transaction에서 고정한다.
// 경로의 구조 검증은 호출자 책임이다. capture는 참조 수를 변경하지 않는다.
// DB 시각 deadline과 grace 설정 검사는 실행 중 원본 보존의 증명이 아니다. 규칙은 docs/design/17-file-extract.md "실행".
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { toPreconditionCurrent } from '../vfs/dto/node-response.dto.js';
import { decodeRevision } from '../vfs/revision.js';
import {
  VfsExtractDeadlineExceededError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsPreconditionFailedError,
} from '../vfs/vfs.errors.js';
import { isDbDeadlinePassed, readDbWallClock } from './db-deadline.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { joinSegments } from './vfs-node.repository.helpers.js';

/** capture할 원본과 대상이다. 경로는 정규화한 segment 목록이며 root는 아니다. */
export interface ExtractSourceCommand {
  readonly sourceSegments: string[];

  /** 원본 FILE이 일치해야 하는 revision이다. */
  readonly sourceRevision: string;

  readonly destinationSegments: string[];

  /** 지정하면 대상 DIRECTORY가 일치해야 하는 revision이다. 생략하면 어떤 조건도 걸지 않는다. */
  readonly destinationRevision?: string;
}

/** 같은 DB snapshot에서 읽은 extract 실행 입력이다. */
export interface ExtractSourceCapture {
  /** capture 시각에 고정한 실행 종료 시각이다. DB wall-clock 기준이다. */
  readonly deadlineAt: Date;

  readonly source: {
    readonly nodeId: string;

    /** storage 내부에서 콘텐츠를 찾는 key다. */
    readonly storageKey: string;

    /** 복호화 후 평문 byte 수다. */
    readonly size: bigint;

    /** 복호화된 원본 전체의 SHA-256이다. */
    readonly sha256: string;

    /** namespace가 암호화된 경우 사용하는 IV다. */
    readonly encryptionIv: Buffer | null;
  };
}

/** extract 원본을 읽기 전용 DB snapshot으로 고정한다. */
@Injectable()
export class ExtractSourceRepository {
  /** 저장소의 DataSource를 받는다. */
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 원본, 대상 사전조건, 실행 deadline을 한 snapshot에서 capture한다.
   *
   * 오류 순서는 source 조건(404·412), destination 조건(404·409·412)이다.
   * source는 FILE이어야 한다. 부재, DIRECTORY, FILE 조상 아래는 모두 404다.
   * source가 destination 아래에 있어도 허용한다.
   */
  @classifyPersistenceOperation
  async capture(
    namespaceId: string,
    rootId: string,
    command: ExtractSourceCommand,
    maxSeconds: number,
  ): Promise<ExtractSourceCapture> {
    const work = async (manager: EntityManager): Promise<ExtractSourceCapture> => {
      const dbNow = await readDbWallClock(manager, this.isSqlite);
      const deadlineAt = new Date(dbNow.getTime() + maxSeconds * 1000);

      const namespace = await manager.getRepository(NamespaceEntity).findOneBy({ id: namespaceId });
      if (!namespace || namespace.status !== 'ACTIVE') throw new VfsNamespaceNotFoundError(namespaceId);
      const nodes = manager.getRepository(VfsNodeEntity);
      const root = await nodes.findOneBy({ id: rootId, namespaceId, parentId: IsNull() });
      if (!root) throw new VfsNamespaceNotFoundError(namespaceId);

      const source = await this.readSource(manager, namespaceId, root, command);
      await this.assertDestination(manager, namespaceId, root, command);
      return { deadlineAt, source };
    };
    return this.isSqlite
      ? this.dataSource.transaction(work)
      : this.dataSource.transaction('REPEATABLE READ', work);
  }

  /** 최종 mutation transaction에서 DB wall-clock deadline을 검사한다. */
  @classifyPersistenceOperation
  async assertDeadline(manager: EntityManager, deadlineAt: Date): Promise<void> {
    if (await isDbDeadlinePassed(manager, this.isSqlite, deadlineAt))
      throw new VfsExtractDeadlineExceededError();
  }

  private get isSqlite(): boolean {
    return isSqliteDataSource(this.dataSource.options);
  }

  /** source FILE을 찾아 revision을 확인하고 Blob metadata를 읽는다. */
  private async readSource(
    manager: EntityManager,
    namespaceId: string,
    root: VfsNodeEntity,
    command: ExtractSourceCommand,
  ): Promise<ExtractSourceCapture['source']> {
    const path = joinSegments(command.sourceSegments);
    const nodes = manager.getRepository(VfsNodeEntity);
    let node: VfsNodeEntity | null = root;
    for (const name of command.sourceSegments) {
      // FILE 아래로는 내려갈 수 없으므로 source가 존재할 수 없다.
      if (node.type !== 'DIRECTORY') throw new VfsNodeNotFoundError(path);
      node = await nodes.findOneBy({ namespaceId, parentId: node.id, name });
      if (!node) throw new VfsNodeNotFoundError(path);
    }
    if (node.type !== 'FILE') throw new VfsNodeNotFoundError(path);
    const expected = decodeRevision(command.sourceRevision);
    if (expected.id !== node.id.toLowerCase() || expected.version !== node.version) {
      throw new VfsPreconditionFailedError(path, toPreconditionCurrent(node, path));
    }
    if (!node.blobId || node.size === null)
      throw new Error('FILE node에 Blob 또는 size가 없음 — 데이터 일관성 위반');
    const blob = await manager.getRepository(BlobEntity).findOneBy({ id: node.blobId, namespaceId });
    if (!blob) throw new Error('FILE node가 참조하는 Blob이 없음 — 데이터 일관성 위반');
    return {
      nodeId: node.id,
      storageKey: blob.storageKey,
      size: BigInt(node.size),
      sha256: blob.sha256,
      encryptionIv: blob.encryptionIv,
    };
  }

  /**
   * 대상 DIRECTORY의 사전조건을 확인한다.
   * 부모 사슬은 있어야 한다. 대상 자체는 없어도 된다(커밋에서 만든다).
   * 조상이나 대상이 FILE이면 409, 부재한 조상은 첫 부재 경로의 404다.
   */
  private async assertDestination(
    manager: EntityManager,
    namespaceId: string,
    root: VfsNodeEntity,
    command: ExtractSourceCommand,
  ): Promise<void> {
    const segments = command.destinationSegments;
    const path = joinSegments(segments);
    const nodes = manager.getRepository(VfsNodeEntity);
    let parent: VfsNodeEntity = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const child = await nodes.findOneBy({ namespaceId, parentId: parent.id, name: segments[index] });
      if (!child) throw new VfsNodeNotFoundError(joinSegments(segments.slice(0, index + 1)));
      if (child.type !== 'DIRECTORY')
        throw new VfsNotDirectoryError(joinSegments(segments.slice(0, index + 1)));
      parent = child;
    }
    const target = await nodes.findOneBy({
      namespaceId,
      parentId: parent.id,
      name: segments[segments.length - 1],
    });
    if (target && target.type !== 'DIRECTORY') throw new VfsNotDirectoryError(path);
    if (command.destinationRevision === undefined) return;
    if (!target) throw new VfsNodeNotFoundError(path);
    const expected = decodeRevision(command.destinationRevision);
    if (expected.id !== target.id.toLowerCase() || expected.version !== target.version) {
      throw new VfsPreconditionFailedError(path, toPreconditionCurrent(target, path));
    }
  }
}
