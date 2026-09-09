import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { NamespaceEncryptionNotConfiguredError } from '../encryption/encryption.errors.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { AccessPolicy, EncryptionPolicy, NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { NamespaceProvisioningRepository } from '../persistence/namespace-provisioning.repository.js';
import { NamespaceResponseDto, toNamespaceResponse } from './dto/namespace-response.dto.js';
import { IdempotencyKeyReusedError, NamespaceAlreadyExistsError, NamespaceNotFoundError } from './namespace.errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface CreateNamespaceResult {
  readonly status: number;
  readonly body: NamespaceResponseDto | { code: string; message: string };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

@Injectable()
export class NamespaceService {
  constructor(
    @InjectRepository(NamespaceEntity) private readonly namespaceRepo: Repository<NamespaceEntity>,
    @InjectRepository(IdempotencyKeyEntity) private readonly idempotencyRepo: Repository<IdempotencyKeyEntity>,
    private readonly provisioningRepo: NamespaceProvisioningRepository,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
  ) {}

  async create(
    idempotencyKey: string,
    name: string,
    encryptionPolicy: EncryptionPolicy = 'NONE',
    accessPolicy: AccessPolicy = 'PRIVATE',
  ): Promise<CreateNamespaceResult> {
    if (encryptionPolicy === 'ENCRYPTED' && !this.masterKey) {
      throw new NamespaceEncryptionNotConfiguredError();
    }

    // accessPolicy를 해시에 포함하지 않으면 같은 Idempotency-Key로 정책만 바꾼
    // 재요청이 IdempotencyKeyReusedError 없이 캐시 응답을 돌려준다.
    const requestHash = canonicalJsonHash({ name, encryptionPolicy, accessPolicy });

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
      return { status: existing.responseStatus, body: existing.responseBody as CreateNamespaceResult['body'] };
    }

    try {
      const namespace = await this.provisioningRepo.createWithRoot(name, encryptionPolicy, accessPolicy);
      const body = toNamespaceResponse(namespace);
      await this.recordIdempotency(idempotencyKey, requestHash, 201, body);
      return { status: 201, body };
    } catch (error) {
      if (error instanceof NamespaceAlreadyExistsError) {
        const body = { code: error.code, message: error.message };
        await this.recordIdempotency(idempotencyKey, requestHash, 409, body);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<NamespaceResponseDto> {
    if (!UUID_PATTERN.test(id)) {
      throw new NamespaceNotFoundError(id);
    }

    const namespace = await this.namespaceRepo.findOneBy({ id });
    if (!namespace) {
      throw new NamespaceNotFoundError(id);
    }

    return toNamespaceResponse(namespace);
  }

  async findAll(): Promise<NamespaceResponseDto[]> {
    const namespaces = await this.namespaceRepo.find({
      where: { status: 'ACTIVE' },
      order: { name: 'ASC', id: 'ASC' },
    });

    return namespaces.map(toNamespaceResponse);
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
