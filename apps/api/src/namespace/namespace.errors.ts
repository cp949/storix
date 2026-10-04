import { DomainError } from '../common/domain-error.js';

export class NamespaceAlreadyExistsError extends DomainError {
  readonly code = 'NAMESPACE_ALREADY_EXISTS';
  readonly status = 409;

  constructor(readonly namespaceName: string | null) {
    super(`이미 존재하는 namespace name: ${namespaceName ?? ''}`);
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

  constructor(message = 'Idempotency-Key 헤더가 필요함') {
    super(message);
  }
}

export class NamespaceInvalidNameError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_NAME';
  readonly status = 400;

  constructor(readonly namespaceName: unknown) {
    super(`유효하지 않은 namespace name: ${JSON.stringify(namespaceName)}`);
  }
}

export class NamespaceInvalidIdPrefixError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_ID_PREFIX';
  readonly status = 400;

  constructor(readonly idPrefix: unknown) {
    super(`유효하지 않은 namespace ID prefix: ${JSON.stringify(idPrefix)}`);
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

export class NamespaceInvalidTotalLogicalBytesError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES';
  readonly status = 400;

  constructor(readonly value: unknown) {
    super(
      'quota 요청은 1 이상의 int64 범위 decimal string 또는 null인 maxTotalLogicalBytes 필드만 포함해야 함',
    );
  }
}

export class NamespaceInvalidTrashPolicyError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_TRASH_POLICY';
  readonly status = 400;

  constructor() {
    super('trash 정책 요청은 enabled boolean 필드만 포함해야 함');
  }
}

export class NamespaceInvalidSettingsRequestError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_SETTINGS_REQUEST';
  readonly status = 400;

  constructor() {
    super('namespace settings 요청은 지원 필드 하나 이상과 유효한 값을 포함해야 함');
  }
}

export class NamespaceSettingExceedsCeilingError extends DomainError {
  readonly code = 'NAMESPACE_SETTING_EXCEEDS_CEILING';
  readonly status = 400;

  constructor(
    readonly field: string,
    readonly value: string,
    readonly ceiling: string,
  ) {
    super(`${field} 값 ${value}가 전역 ceiling ${ceiling}을 초과함`);
  }
}

export class NamespaceQuotaLimitExceedsGlobalError extends DomainError {
  readonly code = 'NAMESPACE_QUOTA_LIMIT_EXCEEDS_GLOBAL';
  readonly status = 400;

  constructor() {
    super('namespace quota가 Storix 전체 논리 바이트 상한을 초과함');
  }
}

export class NamespaceInvalidDeleteRequestError extends DomainError {
  readonly code = 'NAMESPACE_INVALID_DELETE_REQUEST';
  readonly status = 400;
  constructor() {
    super('namespace 삭제 요청은 body 없이 255 byte 이하 Idempotency-Key를 보내야 함');
  }
}

export class NamespaceDeletionNotFoundError extends DomainError {
  readonly code = 'NAMESPACE_DELETION_NOT_FOUND';
  readonly status = 404;
  constructor(readonly namespaceId: string) {
    super(`삭제 작업이 없는 namespace: ${namespaceId}`);
  }
}
