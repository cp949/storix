import { NamespaceInvalidSettingsRequestError } from '../namespace.errors.js';

export type NamespaceSettingsNumberField =
  'maxTotalLogicalBytes' | 'maxFileSizeBytes' | 'maxFilesPerFolder' | 'maxNodes' | 'maxRetainedTrashBytes';

export interface UpdateNamespaceSettingsRequest {
  readonly maxTotalLogicalBytes?: string | null;
  readonly maxFileSizeBytes?: string | null;
  readonly maxFilesPerFolder?: string | null;
  readonly maxNodes?: string | null;
  readonly maxRetainedTrashBytes?: string | null;
  readonly excludeTrashFromQuota?: boolean;
  readonly excludeSnapshotsFromQuota?: boolean;
  readonly trashEnabled?: boolean;
}

const NUMBER_FIELDS = new Set<NamespaceSettingsNumberField>([
  'maxTotalLogicalBytes',
  'maxFileSizeBytes',
  'maxFilesPerFolder',
  'maxNodes',
  'maxRetainedTrashBytes',
]);
const BOOLEAN_FIELDS = new Set(['excludeTrashFromQuota', 'excludeSnapshotsFromQuota', 'trashEnabled']);

function isPositiveInt64Decimal(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false;
  return BigInt(value) <= 9223372036854775807n;
}

export function parseUpdateNamespaceSettingsRequest(body: unknown): UpdateNamespaceSettingsRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new NamespaceInvalidSettingsRequestError();
  }
  const record = body as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length === 0) throw new NamespaceInvalidSettingsRequestError();

  for (const field of fields) {
    if (NUMBER_FIELDS.has(field as NamespaceSettingsNumberField)) {
      const value = record[field];
      if (value !== null && !isPositiveInt64Decimal(value)) throw new NamespaceInvalidSettingsRequestError();
    } else if (BOOLEAN_FIELDS.has(field)) {
      if (typeof record[field] !== 'boolean') throw new NamespaceInvalidSettingsRequestError();
    } else {
      throw new NamespaceInvalidSettingsRequestError();
    }
  }
  return record as UpdateNamespaceSettingsRequest;
}
