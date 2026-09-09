import { DomainError } from '../common/domain-error.js';

export class NamespaceAlreadyExistsError extends DomainError {
  readonly code = 'NAMESPACE_ALREADY_EXISTS';
  readonly status = 409;

  constructor(readonly namespaceName: string) {
    super(`이미 존재하는 namespace name: ${namespaceName}`);
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly status = 422;

  constructor(readonly idempotencyKey: string) {
    super(`같은 Idempotency-Key가 다른 요청에 재사용됨: ${idempotencyKey}`);
  }
}

export class IdempotencyKeyRequiredError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  readonly status = 400;

  constructor() {
    super('Idempotency-Key 헤더가 필요함');
  }
}

export class NamespaceInvalidNameError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_NAME';
  readonly status = 400;

  constructor(readonly namespaceName: unknown) {
    super(`유효하지 않은 namespace name: ${JSON.stringify(namespaceName)}`);
  }
}

export class NamespaceNotFoundError extends DomainError {
  readonly code = 'NAMESPACE_NOT_FOUND';
  readonly status = 404;

  constructor(readonly namespaceId: string) {
    super(`존재하지 않는 namespace: ${namespaceId}`);
  }
}

export class NamespaceInvalidEncryptionPolicyError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_ENCRYPTION_POLICY';
  readonly status = 400;

  constructor(readonly value: unknown) {
    super(`유효하지 않은 encryptionPolicy: ${JSON.stringify(value)}`);
  }
}

export class NamespaceInvalidAccessPolicyError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_ACCESS_POLICY';
  readonly status = 400;

  constructor(readonly value: unknown) {
    super(`유효하지 않은 accessPolicy: ${JSON.stringify(value)}`);
  }
}

export class NamespacePublicEncryptionConflictError extends DomainError {
  readonly code = 'NAMESPACE_PUBLIC_ENCRYPTION_CONFLICT';
  readonly status = 400;

  constructor() {
    super('ENCRYPTED namespace는 PUBLIC으로 생성할 수 없음');
  }
}
