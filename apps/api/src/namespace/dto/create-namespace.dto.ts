import { AccessPolicy, EncryptionPolicy } from '../../persistence/entities/namespace.entity.js';
import {
  NamespaceInvalidAccessPolicyError,
  NamespaceInvalidEncryptionPolicyError,
  NamespaceInvalidNameError,
  NamespacePublicEncryptionConflictError,
} from '../namespace.errors.js';

const NAMESPACE_NAME_PATTERN = /^[a-z0-9_-]{1,128}$/;
const VALID_ENCRYPTION_POLICIES: readonly EncryptionPolicy[] = ['NONE', 'ENCRYPTED'];
const VALID_ACCESS_POLICIES: readonly AccessPolicy[] = ['PRIVATE', 'PUBLIC'];

export interface CreateNamespaceRequest {
  readonly name: string;
  readonly encryptionPolicy: EncryptionPolicy;
  readonly accessPolicy: AccessPolicy;
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

  const rawAccessPolicy = record.accessPolicy;
  if (rawAccessPolicy !== undefined && !VALID_ACCESS_POLICIES.includes(rawAccessPolicy as AccessPolicy)) {
    throw new NamespaceInvalidAccessPolicyError(rawAccessPolicy);
  }

  const encryptionPolicy = (rawPolicy as EncryptionPolicy | undefined) ?? 'NONE';
  const accessPolicy = (rawAccessPolicy as AccessPolicy | undefined) ?? 'PRIVATE';

  // 두 정책 모두 생성 후 변경할 수 없으므로 생성 시점 검증 1회로 조합이 영구히
  // 배제된다. 암호화 데이터가 무인증으로 복호화되어 나가는 경로를 막는다.
  if (encryptionPolicy === 'ENCRYPTED' && accessPolicy === 'PUBLIC') {
    throw new NamespacePublicEncryptionConflictError();
  }

  return { name, encryptionPolicy, accessPolicy };
}
