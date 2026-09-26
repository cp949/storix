import { DomainError } from '../common/domain-error.js';
import { StorageFailureError, StorageUnavailableError } from '../common/storage-failure.errors.js';

// DB 저장 장애 분류표. 값은 PostgreSQL SQLSTATE, better-sqlite3 결과 코드, pg 연결의 Node Error.code다.
// 23505·SQLITE_CONSTRAINT_*는 기존 충돌 처리(409 등)가 맡으므로 여기서 분류하지 않는다.
const TEMPORARY_CODES = new Set([
  '08000',
  '08003',
  '08006',
  '40001',
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);
const PERMANENT_CODES = new Set(['53100', 'XX001', 'SQLITE_FULL', 'SQLITE_CORRUPT', 'SQLITE_READONLY']);
// better-sqlite3는 확장 결과 코드를 켜므로 SQLITE_BUSY_SNAPSHOT처럼 접미사가 붙어 온다. BUSY·LOCKED·CORRUPT는
// 모든 확장 코드가 기본 코드와 같은 의미라 기본 코드로 접는다. READONLY_RECOVERY처럼 기본 코드와 일시성이 다른
// 계열은 접지 않는다.
const SQLITE_FOLDED_FAMILY = /^(SQLITE_(?:BUSY|LOCKED|CORRUPT))_[A-Z]+$/;

export function classifyPersistenceFailure(error: unknown): DomainError | null {
  if (error instanceof DomainError || typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  const rawCode = candidate.driverError?.code ?? candidate.code;
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.replace(SQLITE_FOLDED_FAMILY, '$1');
  if (TEMPORARY_CODES.has(code)) return new StorageUnavailableError(undefined, { cause: error });
  if (PERMANENT_CODES.has(code)) return new StorageFailureError(undefined, { cause: error });
  return null;
}

/** DB repository 공개 연산에서 빠져나오는 오류만 분류하는 method decorator다. */
export function classifyPersistenceOperation(
  _target: unknown,
  _propertyKey: string,
  descriptor: PropertyDescriptor,
): void {
  const operation = descriptor.value as (...args: unknown[]) => Promise<unknown>;
  descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    try {
      return await operation.apply(this, args);
    } catch (error) {
      throw classifyPersistenceFailure(error) ?? error;
    }
  };
}
