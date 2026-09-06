import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { NamespaceAlreadyExistsError } from '../namespace/namespace.errors.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

@Injectable()
export class NamespaceProvisioningRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createWithRoot(name: string): Promise<NamespaceEntity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const namespace = await manager.save(manager.create(NamespaceEntity, { name }));
        await manager.save(
          manager.create(VfsNodeEntity, {
            namespaceId: namespace.id,
            parentId: null,
            type: 'DIRECTORY',
            name: '',
          }),
        );

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
