import { readFile } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { validate as isUuid } from 'uuid';
import type { CapabilityConfig } from '../capability/capability-config.js';

export const UPLOAD_SESSION_POLICY = Symbol('UPLOAD_SESSION_POLICY');
const MAX_INT64 = 9223372036854775807n;

export interface UploadSessionLimits {
  readonly maxStagedBytes: bigint;
  readonly maxActiveSessions: number;
}

export interface UploadSessionPolicy {
  readonly global: UploadSessionLimits & {
    readonly partSizeBytes: number;
    readonly inactivitySeconds: number;
    readonly maxLifetimeSeconds: number;
  };
  readonly namespaces: Readonly<Record<string, UploadSessionLimits>>;
}

function object(
  value: unknown,
  keys: readonly string[],
  required: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid upload session policy: ${name}`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`Invalid upload session policy keys: ${name}`);
  }
  return record;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid upload session policy integer: ${name}`);
  }
  return value;
}

function bytes(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Invalid upload session policy bytes: ${name}`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) throw new Error(`Upload session policy exceeds int64: ${name}`);
  return parsed;
}

function limits(value: unknown, name: string): UploadSessionLimits {
  const row = object(
    value,
    ['maxStagedBytes', 'maxActiveSessions'],
    ['maxStagedBytes', 'maxActiveSessions'],
    name,
  );
  return {
    maxStagedBytes: bytes(row.maxStagedBytes, `${name}.maxStagedBytes`),
    maxActiveSessions: positiveInteger(row.maxActiveSessions, `${name}.maxActiveSessions`),
  };
}

/**
 * namespace의 업로드 세션 한도를 돌려준다. namespace 항목이 있으면 그 값이고 없으면 전역 한도다.
 * 두 업로드 서비스가 같은 규칙을 쓴다.
 */
export function resolveNamespaceUploadLimits(
  policy: UploadSessionPolicy,
  namespaceId: string,
): UploadSessionLimits {
  return (
    policy.namespaces[namespaceId.toLowerCase()] ?? {
      maxStagedBytes: policy.global.maxStagedBytes,
      maxActiveSessions: policy.global.maxActiveSessions,
    }
  );
}

export function parseUploadSessionPolicy(value: unknown): UploadSessionPolicy {
  const root = object(value, ['global', 'namespaces'], ['global', 'namespaces'], 'root');
  const globalRow = object(
    root.global,
    ['maxStagedBytes', 'maxActiveSessions', 'partSizeBytes', 'inactivitySeconds', 'maxLifetimeSeconds'],
    ['maxStagedBytes', 'maxActiveSessions'],
    'global',
  );
  const global = {
    ...limits(
      { maxStagedBytes: globalRow.maxStagedBytes, maxActiveSessions: globalRow.maxActiveSessions },
      'global',
    ),
    partSizeBytes: positiveInteger(
      globalRow.partSizeBytes === undefined ? 16777216 : globalRow.partSizeBytes,
      'global.partSizeBytes',
    ),
    inactivitySeconds: positiveInteger(
      globalRow.inactivitySeconds === undefined ? 86400 : globalRow.inactivitySeconds,
      'global.inactivitySeconds',
    ),
    maxLifetimeSeconds: positiveInteger(
      globalRow.maxLifetimeSeconds === undefined ? 604800 : globalRow.maxLifetimeSeconds,
      'global.maxLifetimeSeconds',
    ),
  };
  if (global.partSizeBytes > 2147483647)
    throw new Error('Upload session part size exceeds database integer range');
  if (global.inactivitySeconds > global.maxLifetimeSeconds)
    throw new Error('Upload session inactivity exceeds lifetime');
  const maxDateMs = 8_640_000_000_000_000;
  if (
    !Number.isFinite(Date.now() + global.maxLifetimeSeconds * 1000) ||
    Date.now() + global.maxLifetimeSeconds * 1000 > maxDateMs
  )
    throw new Error('Upload session lifetime exceeds Date range');
  if (root.namespaces === null || typeof root.namespaces !== 'object' || Array.isArray(root.namespaces)) {
    throw new Error('Invalid upload session policy: namespaces');
  }
  const rows = root.namespaces as Record<string, unknown>;
  const namespaces: Record<string, UploadSessionLimits> = {};
  for (const [id, row] of Object.entries(rows)) {
    if (!isUuid(id)) throw new Error(`Invalid upload session namespace ID: ${id}`);
    const normalized = id.toLowerCase();
    if (Object.hasOwn(namespaces, normalized))
      throw new Error(`Duplicate upload session namespace ID: ${normalized}`);
    const parsed = limits(row, `namespaces.${id}`);
    if (
      parsed.maxStagedBytes > global.maxStagedBytes ||
      parsed.maxActiveSessions > global.maxActiveSessions
    ) {
      throw new Error(`Upload session namespace limit exceeds global: ${id}`);
    }
    namespaces[normalized] = parsed;
  }
  return { global, namespaces };
}

export async function loadUploadSessionPolicy(
  config: ConfigService,
  capabilities: CapabilityConfig,
): Promise<UploadSessionPolicy | null> {
  const path = config.get<string>('STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH');
  if (!path) {
    if (
      capabilities.globalAllowedCapabilities.includes('resumable-upload') ||
      Object.values(capabilities.namespaceAllowedCapabilities).some((ids) => ids.includes('resumable-upload'))
    ) {
      throw new Error('Upload session policy required when resumable-upload is enabled');
    }
    return null;
  }
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read upload session policy at ${path}`, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new Error(`Invalid upload session policy JSON at ${path}`, { cause });
  }
  return parseUploadSessionPolicy(value);
}
