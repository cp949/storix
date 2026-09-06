import { EncryptionPolicy, NamespaceEntity, NamespaceStatus } from '../../persistence/entities/namespace.entity.js';

export interface NamespaceResponseDto {
  readonly id: string;
  readonly name: string;
  readonly encryptionPolicy: EncryptionPolicy;
  readonly status: NamespaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toNamespaceResponse(entity: NamespaceEntity): NamespaceResponseDto {
  return {
    id: entity.id,
    name: entity.name,
    encryptionPolicy: entity.encryptionPolicy,
    status: entity.status,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}
