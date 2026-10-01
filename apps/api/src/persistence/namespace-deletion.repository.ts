/**
 * 삭제 상태 전환과 최초 응답을 하나의 트랜잭션으로 저장한다.
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금". 결정은 api ADR-0032.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { isSqliteDataSource } from '../common/db-driver.js';
import { NamespaceEntity, NamespaceStatus } from './entities/namespace.entity.js';
import {
  NamespaceDeletionEntity,
  NamespaceDeletionPhase,
  NamespaceDeletionBlockedReason,
} from './entities/namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from './entities/namespace-deletion-receipt.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { VfsUploadSessionRepository } from './vfs-upload-session.repository.js';

/** 최초 접수와 저장된 응답 재생을 구분한다. */
export type DeletionAcceptResult =
  | { readonly kind: 'replay'; readonly status: number; readonly body: DeletionAcceptBody }
  | { readonly kind: 'stored'; readonly status: 202 | 200; readonly body: DeletionAcceptBody };

/** 삭제 요청의 최초 응답 body다. */
export interface DeletionAcceptBody {
  /** 삭제 대상 UUID다. */
  readonly namespaceId: string;

  /** 최초 응답 시점의 namespace 상태다. */
  readonly status: 'DELETING' | 'DELETED';
}

/** namespace 상태와 삭제 operation의 현재 위치다. */
export interface DeletionStatusView {
  /** 삭제 대상 UUID다. */
  readonly namespaceId: string;

  /** 현재 namespace 상태다. */
  readonly status: NamespaceStatus;

  /** 정리 단계다. */
  readonly phase: NamespaceDeletionPhase;

  /** 접수 시각이다. */
  readonly requestedAt: Date;

  /** 완료 전에는 null이다. */
  readonly completedAt: Date | null;

  /** 자동 정리 보류 원인이다. */
  readonly blockedReason: NamespaceDeletionBlockedReason | null;
}

/**
 * 삭제 접수의 상태 전환과 최초 응답 receipt를 한 트랜잭션으로 저장하고 상태를 조회한다.
 *
 * - root 행(완료 경쟁으로 root가 없으면 operation 행)을 잠가 같은 namespace의 접수를 직렬화한다.
 * - SQLite는 행 잠금을 쓰지 않는다.
 * - 같은 key hash의 재요청은 저장된 최초 응답을 재생한다.
 *
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금".
 */
@Injectable()
export class NamespaceDeletionRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly uploads: VfsUploadSessionRepository,
  ) {}

  /** root 또는 완료 operation을 잠그고 상태 전환과 receipt를 함께 커밋한다. */
  @classifyPersistenceOperation
  async accept(namespaceId: string, keyHash: string, now: Date): Promise<DeletionAcceptResult | null> {
    return this.dataSource.transaction(async (manager) => {
      const initial = await manager.findOneBy(NamespaceEntity, { id: namespaceId });
      if (!initial) return null;
      const rootQuery = manager
        .getRepository(VfsNodeEntity)
        .createQueryBuilder('root')
        .where({ namespaceId, parentId: IsNull(), type: 'DIRECTORY', name: '' });
      if (!isSqliteDataSource(this.dataSource.options)) rootQuery.setLock('pessimistic_write');
      // 완료 경합으로 root가 사라졌으면 operation 행을 잠가 receipt를 직렬화한다.
      const root = initial.status === 'DELETED' ? null : await rootQuery.getOne();
      const operationQuery = manager
        .getRepository(NamespaceDeletionEntity)
        .createQueryBuilder('operation')
        .where({ namespaceId });
      if (!root && !isSqliteDataSource(this.dataSource.options)) operationQuery.setLock('pessimistic_write');
      const operation = await operationQuery.getOne();
      const receipt = await manager.findOneBy(NamespaceDeletionReceiptEntity, { namespaceId, keyHash });
      if (receipt) return { kind: 'replay', status: receipt.responseStatus, body: receipt.responseBody };
      const namespace = await manager.findOneByOrFail(NamespaceEntity, { id: namespaceId });
      if (operation?.phase === 'COMPLETED') {
        return this.saveReceipt(manager, namespaceId, keyHash, 200, 'DELETED', now);
      }
      if (!root) throw new Error(`Namespace deletion root missing: ${namespaceId}`);
      if (namespace.status === 'ACTIVE') {
        await this.uploads.lockUsageForNamespace(manager, namespaceId);
        await manager.update(NamespaceEntity, { id: namespaceId }, { status: 'DELETING' });
        await manager.insert(NamespaceDeletionEntity, {
          namespaceId,
          phase: 'UPLOADS',
          requestedAt: now,
          updatedAt: now,
          completedAt: null,
          blockedReason: null,
        });
      } else if (namespace.status !== 'DELETING' || !operation) {
        throw new Error(`Namespace deletion state inconsistent: ${namespaceId}`);
      }
      return this.saveReceipt(manager, namespaceId, keyHash, 202, 'DELETING', now);
    });
  }

  /** 한 SELECT snapshot에서 namespace 상태와 operation을 함께 읽는다. */
  @classifyPersistenceOperation
  async findStatus(
    namespaceId: string,
  ): Promise<{ namespaceExists: boolean; view: DeletionStatusView | null }> {
    const row = (await this.dataSource
      .getRepository(NamespaceEntity)
      .createQueryBuilder('namespace')
      .leftJoinAndMapOne(
        'namespace.deletion',
        NamespaceDeletionEntity,
        'deletion',
        'deletion.namespace_id = namespace.id',
      )
      .where('namespace.id = :namespaceId', { namespaceId })
      .getOne()) as (NamespaceEntity & { deletion: NamespaceDeletionEntity | null }) | null;
    if (!row) return { namespaceExists: false, view: null };
    if (!row.deletion) return { namespaceExists: true, view: null };
    return {
      namespaceExists: true,
      view: {
        namespaceId: row.id,
        status: row.status,
        phase: row.deletion.phase,
        requestedAt: row.deletion.requestedAt,
        completedAt: row.deletion.completedAt,
        blockedReason: row.deletion.blockedReason,
      },
    };
  }

  private async saveReceipt(
    manager: EntityManager,
    namespaceId: string,
    keyHash: string,
    status: 202 | 200,
    namespaceStatus: 'DELETING' | 'DELETED',
    now: Date,
  ): Promise<DeletionAcceptResult> {
    const body = { namespaceId, status: namespaceStatus };
    await manager.insert(NamespaceDeletionReceiptEntity, {
      namespaceId,
      keyHash,
      responseStatus: status,
      responseBody: body,
      createdAt: now,
    });
    return { kind: 'stored', status, body };
  }
}
