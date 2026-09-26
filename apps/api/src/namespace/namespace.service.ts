import { Inject, Injectable } from '@nestjs/common';
import { classifyPersistenceFailure } from '../persistence/persistence-failure.js';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { NamespaceEncryptionNotConfiguredError } from '../encryption/encryption.errors.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { AccessPolicy, EncryptionPolicy, NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { NamespaceProvisioningRepository } from '../persistence/namespace-provisioning.repository.js';
import { NamespaceResponseDto, toNamespaceResponse } from './dto/namespace-response.dto.js';
import { NamespaceGlobalLimits, readNamespaceGlobalLimits } from './namespace-global-limits.js';
import {
  IdempotencyKeyReusedError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
} from './namespace.errors.js';
import { assertNamespaceQuotaWithinGlobalLimit } from '../vfs/namespace-quota.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (!UUID_PATTERN.test(id)) {
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

    return toNamespaceResponse(namespace, this.globalLimits);
  }

  async findAll(): Promise<NamespaceResponseDto[]> {
    const namespaces = await this.namespaceRepo.find({
      where: { status: 'ACTIVE' },
      order: { name: 'ASC', id: 'ASC' },
    });

    return namespaces.map((namespace) => toNamespaceResponse(namespace, this.globalLimits));
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
