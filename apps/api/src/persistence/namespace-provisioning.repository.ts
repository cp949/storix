import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessPolicy, EncryptionPolicy, NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { NamespaceAlreadyExistsError } from '../namespace/namespace.errors.js';
import { NamespaceCreationReceiptInput, NamespaceCreationReceiptWriter } from './namespace-creation-receipt.writer.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown }; message?: unknown };
  const code = candidate.code ?? candidate.driverError?.code;
  return code === POSTGRES_UNIQUE_VIOLATION ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    (typeof candidate.message === 'string' && /UNIQUE constraint failed/i.test(candidate.message));
}

@Injectable()
export class NamespaceProvisioningRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly receiptWriter: NamespaceCreationReceiptWriter = new NamespaceCreationReceiptWriter(),
  ) {}

  async createWithRoot(
    name: string,
    encryptionPolicy: EncryptionPolicy = 'NONE',
    accessPolicy: AccessPolicy = 'PRIVATE',
    maxTotalLogicalBytes: string | null = null,
    receipt?: Omit<NamespaceCreationReceiptInput, 'responseBody'> & {
      readonly responseBody: (namespace: NamespaceEntity) => Record<string, unknown>;
    },
  ): Promise<NamespaceEntity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const namespace = await manager.save(
          manager.create(NamespaceEntity, { name, encryptionPolicy, accessPolicy, maxTotalLogicalBytes }),
        );
        await manager.save(
          manager.create(VfsNodeEntity, {
            namespaceId: namespace.id,
            parentId: null,
            type: 'DIRECTORY',
            name: '',
          }),
        );

        if (receipt) {
          await this.receiptWriter.save(manager, {
            ...receipt,
            responseBody: receipt.responseBody(namespace),
          });
        }

        return namespace;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new NamespaceAlreadyExistsError(name);
      }
      throw error;
    }
  }
}
