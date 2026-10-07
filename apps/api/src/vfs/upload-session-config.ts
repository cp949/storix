import { readFile } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { assertNoDuplicateJsonKeys } from '../common/json-duplicate-keys.js';
import { isNamespaceId } from '../common/namespace-id.js';
import type { CapabilityConfig } from '../capability/capability-config.js';

export const UPLOAD_SESSION_POLICY = Symbol('UPLOAD_SESSION_POLICY');
const MAX_INT64 = 9223372036854775807n;

export interface UploadSessionLimits {
  readonly maxStagedBytes: bigint;
  readonly maxActiveSessions: number;
}

// 조각 크기의 상한은 세션 테이블의 integer 컬럼이다.
const MAX_PART_SIZE_BYTES = 2147483647;

/** namespace의 필수 업로드 한도와 새 세션에 적용할 선택 조각 크기를 정의한다. */
export interface UploadSessionNamespacePolicy extends UploadSessionLimits {
  /** 이 namespace의 새 세션에 쓰는 조각 크기. 없으면 전역 값을 쓴다. */
  readonly partSizeBytes?: number;
}

export interface UploadSessionPolicy {
  readonly global: UploadSessionLimits & {
    readonly partSizeBytes: number;
    readonly inactivitySeconds: number;
    readonly maxLifetimeSeconds: number;
  };
  readonly namespaces: Readonly<Record<string, UploadSessionNamespacePolicy>>;
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

function partSize(value: unknown, name: string): number {
  const parsed = positiveInteger(value, name);
  if (parsed > MAX_PART_SIZE_BYTES)
    throw new Error('Upload session part size exceeds database integer range');
  return parsed;
}

function bytes(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Invalid upload session policy bytes: ${name}`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) throw new Error(`Upload session policy exceeds int64: ${name}`);
  return parsed;
}

function assertPartSizeFitsStaging(
  partSizeBytes: number,
  maxStagedBytes: bigint,
  scope: string,
  partSizeSource: string,
): void {
  if (BigInt(partSizeBytes) > maxStagedBytes) {
    throw new Error(
      `Upload session part size exceeds staging limit: ${scope}.partSizeBytes=${partSizeBytes} ` +
        `(source=${partSizeSource}), ${scope}.maxStagedBytes=${maxStagedBytes}`,
    );
  }
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
  if (global.partSizeBytes > MAX_PART_SIZE_BYTES)
    throw new Error('Upload session part size exceeds database integer range');
  const globalPartSizeSource =
    globalRow.partSizeBytes === undefined ? 'default(16777216)' : 'global.partSizeBytes';
  assertPartSizeFitsStaging(global.partSizeBytes, global.maxStagedBytes, 'global', globalPartSizeSource);
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
  const namespaces: Record<string, UploadSessionNamespacePolicy> = {};
  for (const [id, row] of Object.entries(rows)) {
    if (!isNamespaceId(id)) throw new Error(`Invalid upload session namespace ID: ${id}`);
    const name = `namespaces.${id}`;
    // 조각 크기는 선택이고 두 한도는 필수다. 조각 크기만 있는 항목은 아래 object()의 필수 키 검사가 거부한다.
    const record = object(
      row,
      ['maxStagedBytes', 'maxActiveSessions', 'partSizeBytes'],
      ['maxStagedBytes', 'maxActiveSessions'],
      name,
    );
    const parsed: UploadSessionNamespacePolicy = {
      ...limits({ maxStagedBytes: record.maxStagedBytes, maxActiveSessions: record.maxActiveSessions }, name),
      ...(record.partSizeBytes === undefined
        ? {}
        : { partSizeBytes: partSize(record.partSizeBytes, `${name}.partSizeBytes`) }),
    };
    if (
      parsed.maxStagedBytes > global.maxStagedBytes ||
      parsed.maxActiveSessions > global.maxActiveSessions
    ) {
      throw new Error(`Upload session namespace limit exceeds global: ${id}`);
    }
    const effectivePartSizeBytes = parsed.partSizeBytes ?? global.partSizeBytes;
    const partSizeSource =
      parsed.partSizeBytes === undefined
        ? `global.partSizeBytes (source=${globalPartSizeSource})`
        : `${name}.partSizeBytes`;
    assertPartSizeFitsStaging(effectivePartSizeBytes, parsed.maxStagedBytes, name, partSizeSource);
    namespaces[id] = parsed;
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
  // JSON.parse는 중복 key를 마지막 값으로 덮어쓰므로 문법이 유효한 텍스트에서 따로 검사한다.
  assertNoDuplicateJsonKeys(contents);
  try {
    return parseUploadSessionPolicy(value);
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith('Upload session part size exceeds staging limit:')
    ) {
      throw new Error(`Invalid upload session policy at ${path}: ${cause.message}`, { cause });
    }
    throw cause;
  }
}
