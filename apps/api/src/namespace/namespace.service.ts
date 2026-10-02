import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { classifyPersistenceFailure } from '../persistence/persistence-failure.js';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { NamespaceEncryptionNotConfiguredError } from '../encryption/encryption.errors.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { AccessPolicy, EncryptionPolicy, NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { NamespaceProvisioningRepository } from '../persistence/namespace-provisioning.repository.js';
import { withExactNamespaceBigints } from '../persistence/namespace-bigint-read.js';
import { NamespaceResponseDto, toNamespaceResponse } from './dto/namespace-response.dto.js';
import { NamespaceGlobalLimits, readNamespaceGlobalLimits } from './namespace-global-limits.js';
import {
  IdempotencyKeyReusedError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
} from './namespace.errors.js';
import { assertNamespaceQuotaWithinGlobalLimit } from '../vfs/namespace-quota.js';
import { resolveLimit } from '../vfs/pagination.js';
import { decodeNamespaceListCursor, encodeNamespaceListCursor } from './namespace-list-cursor.js';
import { generateNamespaceId, isNamespaceId } from '../common/namespace-id.js';

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown }; message?: unknown };
  const code = candidate.code ?? candidate.driverError?.code;
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    (typeof candidate.message === 'string' && /UNIQUE constraint failed/i.test(candidate.message))
  );
}
export interface NamespacePage {
  readonly items: NamespaceResponseDto[];

  /** 이어 읽을 cursor. 마지막 page면 null이다. */
  readonly nextCursor: string | null;
}

export interface CreateNamespaceResult {
  readonly status: number;
  readonly body: NamespaceResponseDto | { code: string; message: string };
}

@Injectable()
export class NamespaceService {
  private readonly globalLimits: NamespaceGlobalLimits;

  constructor(
    @InjectRepository(NamespaceEntity) private readonly namespaceRepo: Repository<NamespaceEntity>,
    @InjectRepository(IdempotencyKeyEntity)
    private readonly idempotencyRepo: Repository<IdempotencyKeyEntity>,
    private readonly provisioningRepo: NamespaceProvisioningRepository,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    config: ConfigService,
  ) {
    this.globalLimits = readNamespaceGlobalLimits(config);
  }

  async create(
    idempotencyKey: string,
    name: string,
    encryptionPolicy: EncryptionPolicy = 'NONE',
    accessPolicy: AccessPolicy = 'PRIVATE',
    maxTotalLogicalBytes: string | null = null,
    idPrefix?: string,
  ): Promise<CreateNamespaceResult> {
    if (encryptionPolicy === 'ENCRYPTED' && !this.masterKey) {
      throw new NamespaceEncryptionNotConfiguredError();
    }

    // accessPolicy를 해시에 포함하지 않으면 같은 Idempotency-Key로 정책만 바꾼
    // 재요청이 IdempotencyKeyReusedError 없이 캐시 응답을 돌려준다.
    try {
      assertNamespaceQuotaWithinGlobalLimit(maxTotalLogicalBytes, this.globalLimits.maxTotalLogicalBytes);
    } catch {
      throw new NamespaceQuotaLimitExceedsGlobalError();
    }

    const requestHash = canonicalJsonHash({
      name,
      ...(idPrefix === undefined ? {} : { idPrefix }),
      encryptionPolicy,
      accessPolicy,
      ...(maxTotalLogicalBytes === null ? {} : { maxTotalLogicalBytes }),
    });

    const existing = await this.idempotencyRepo.findOneBy({ key: idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyKeyReusedError(idempotencyKey);
      }
      if (existing.responseStatus === 409) {
        // 캐시된 오류 응답을 그대로 재생하면 DomainErrorFilter를 거치지 않아 requestId가
        // 빠진다 — 원래 도메인 오류를 다시 던져 항상 필터를 통과하게 한다.
        throw new NamespaceAlreadyExistsError(name);
      }
      return {
        status: existing.responseStatus,
        body: existing.responseBody as CreateNamespaceResult['body'],
      };
    }

    try {
      const namespace = await this.provisioningRepo.createWithRoot(
        generateNamespaceId(idPrefix),
        name,
        encryptionPolicy,
        accessPolicy,
        maxTotalLogicalBytes,
        {
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody: (created) => ({ ...toNamespaceResponse(created, this.globalLimits) }),
        },
      );
      const body = toNamespaceResponse(namespace, this.globalLimits);
      return { status: 201, body };
    } catch (error) {
      // 동시 요청의 transaction이 먼저 커밋됐으면 그 receipt가 이 예외의 정답이다.
      // receipt 저장 실패로 rollback된 경우에는 행이 없으므로 원래 예외를 유지한다.
      let winner: IdempotencyKeyEntity | null = null;
      try {
        winner = await this.idempotencyRepo.findOneBy({ key: idempotencyKey });
      } catch {
        // 조회 실패 시에도 provisioning이 던진 원래 예외를 보존한다.
      }
      if (winner) {
        if (winner.requestHash !== requestHash) {
          throw new IdempotencyKeyReusedError(idempotencyKey);
        }
        if (winner.responseStatus === 201) {
          return {
            status: winner.responseStatus,
            body: winner.responseBody as CreateNamespaceResult['body'],
          };
        }
        if (winner.responseStatus === 409) {
          throw new NamespaceAlreadyExistsError(name);
        }
      }
      if (error instanceof NamespaceAlreadyExistsError) {
        const body = { code: error.code, message: error.message };
        try {
          await this.recordIdempotency(idempotencyKey, requestHash, 409, body);
        } catch {
          // 오류 receipt 저장 실패가 원래 namespace 충돌 오류를 덮지 않게 한다.
        }
      }
      throw error;
    }
  }

  async findById(id: string): Promise<NamespaceResponseDto> {
    if (!isNamespaceId(id)) {
      throw new NamespaceNotFoundError(id);
    }

    let namespace: NamespaceEntity | null;
    try {
      namespace = await this.namespaceRepo.findOneBy({ id });
    } catch (error) {
      throw classifyPersistenceFailure(error) ?? error;
    }
    if (!namespace) {
      throw new NamespaceNotFoundError(id);
    }

    return toNamespaceResponse(
      (await withExactNamespaceBigints(this.namespaceRepo.manager, [namespace]))[0],
      this.globalLimits,
    );
  }

  /**
   * `limit`·`cursor` 없이 호출하는 이전 계약의 전체 목록이다. 개수에 상한이 없어 namespace가 많으면 비용이
   * 개수에 비례한다. 새 호출자는 `findPage`를 쓴다.
   */
  async findAll(): Promise<NamespaceResponseDto[]> {
    const namespaces = await this.namespaceRepo.find({
      where: { status: 'ACTIVE' },
      order: { name: 'ASC', id: 'ASC' },
    });

    return (await withExactNamespaceBigints(this.namespaceRepo.manager, namespaces)).map((namespace) =>
      toNamespaceResponse(namespace, this.globalLimits),
    );
  }

  /**
   * ACTIVE namespace를 `(name, id)` 오름차순 keyset으로 한 page 돌려준다. COUNT·OFFSET을 쓰지 않는다.
   * `limit + 1`개를 읽어 다음 page 존재를 판정한다. 순회 중 생성·삭제는 snapshot을 보장하지 않으며
   * cursor가 가리킨 행이 없어도 그 위치 뒤부터 이어 읽는다.
   */
  async findPage(rawLimit: string | undefined, rawCursor: string | undefined): Promise<NamespacePage> {
    const limit = resolveLimit(rawLimit);
    const after = rawCursor === undefined ? null : decodeNamespaceListCursor(rawCursor);
    const query = this.namespaceRepo
      .createQueryBuilder('n')
      .where("n.status = 'ACTIVE'")
      .orderBy('n.name', 'ASC')
      .addOrderBy('n.id', 'ASC')
      .limit(limit + 1);
    if (after)
      query.andWhere('(n.name, n.id) > (:afterName, :afterId)', { afterName: after.name, afterId: after.id });
    const rows = await query.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const exact = await withExactNamespaceBigints(this.namespaceRepo.manager, page);
    const last = page[page.length - 1];
    return {
      items: exact.map((namespace) => toNamespaceResponse(namespace, this.globalLimits)),
      nextCursor: hasMore ? encodeNamespaceListCursor({ name: last.name, id: last.id }) : null,
    };
  }

  private async recordIdempotency(
    key: string,
    requestHash: string,
    responseStatus: number,
    responseBody: CreateNamespaceResult['body'],
  ): Promise<void> {
    try {
      await this.idempotencyRepo.insert({
        key,
        requestHash,
        responseStatus,
        responseBody,
      } as QueryDeepPartialEntity<IdempotencyKeyEntity>);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }
}
