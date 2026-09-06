import { EncryptionPolicy } from '../../persistence/entities/namespace.entity.js';
import { NamespaceInvalidEncryptionPolicyError, NamespaceInvalidNameError } from '../namespace.errors.js';

const NAMESPACE_NAME_PATTERN = /^[a-z0-9_-]{1,128}$/;
const VALID_ENCRYPTION_POLICIES: readonly EncryptionPolicy[] = ['NONE', 'ENCRYPTED'];

export interface CreateNamespaceRequest {
  readonly name: string;
  readonly encryptionPolicy: EncryptionPolicy;
}

export function parseCreateNamespaceRequest(body: unknown): CreateNamespaceRequest {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const name = record.name;

  if (typeof name !== 'string' || !NAMESPACE_NAME_PATTERN.test(name)) {
    throw new NamespaceInvalidNameError(name);
  }

  const rawPolicy = record.encryptionPolicy;
  if (rawPolicy !== undefined && !VALID_ENCRYPTION_POLICIES.includes(rawPolicy as EncryptionPolicy)) {
    throw new NamespaceInvalidEncryptionPolicyError(rawPolicy);
  }

  return { name, encryptionPolicy: (rawPolicy as EncryptionPolicy | undefined) ?? 'NONE' };
}
