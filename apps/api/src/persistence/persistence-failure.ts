import { DomainError } from '../common/domain-error.js';
import { StorageFailureError, StorageUnavailableError } from '../common/storage-failure.errors.js';

// PostgreSQL SQLSTATE, better-sqlite3 extended result code, Node pg transport Error.code.
// 23505 / SQLITE_CONSTRAINT_* are deliberately left to existing conflict handling.
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

export function classifyPersistenceFailure(error: unknown): DomainError | null {
  if (error instanceof DomainError || typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  const code = candidate.driverError?.code ?? candidate.code;
  if (typeof code !== 'string') return null;
  if (TEMPORARY_CODES.has(code)) return new StorageUnavailableError(undefined, { cause: error });
  if (PERMANENT_CODES.has(code)) return new StorageFailureError(undefined, { cause: error });
  return null;
}

/** Classifies only failures escaping an owned DB repository operation. */
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
