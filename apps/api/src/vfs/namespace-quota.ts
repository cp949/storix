const MAX_SQLITE_AND_POSTGRES_BIGINT = 9223372036854775807n;
const DEFAULT_MAX_TOTAL_LOGICAL_BYTES = 53687091200n;

export interface LogicalByteLimits {
  readonly defaultBytes: bigint;
  readonly ceilingBytes: bigint;
}

function parseNonNegativeBytes(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid total logical byte count');
  const bytes = BigInt(value);
  if (bytes > MAX_SQLITE_AND_POSTGRES_BIGINT) throw new Error('Invalid total logical byte count');
  return bytes;
}

function parsePositiveLimit(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid total logical byte limit');
  const bytes = BigInt(value);
  if (bytes > MAX_SQLITE_AND_POSTGRES_BIGINT) throw new Error('Invalid total logical byte limit');
  return bytes;
}

export function resolveGlobalTotalLogicalByteLimit(value: string | undefined): bigint {
  return resolveGlobalTotalLogicalByteLimits(undefined, value).ceilingBytes;
}

export function resolveGlobalTotalLogicalByteLimits(
  defaultValue: string | undefined,
  ceilingValue: string | undefined,
): LogicalByteLimits {
  const parsedDefault = parseOptionalLimit(defaultValue);
  const parsedCeiling = parseOptionalLimit(ceilingValue);
  const resolvedDefault = parsedDefault ?? parsedCeiling ?? DEFAULT_MAX_TOTAL_LOGICAL_BYTES;
  const resolvedCeiling = parsedCeiling ?? resolvedDefault;
  if (resolvedDefault > resolvedCeiling) throw new Error('total logical bytes default exceeds ceiling');
  return { defaultBytes: resolvedDefault, ceilingBytes: resolvedCeiling };
}

// globalBytes는 호출자가 부팅 시 ConfigService 값을 resolveGlobalTotalLogicalByteLimit로 해석해 넘긴다
export function resolveNamespaceQuota(
  namespaceLimit: string | null,
  ceilingBytes: bigint,
  defaultBytes = ceilingBytes,
): bigint {
  if (namespaceLimit === null) return defaultBytes;
  const namespaceBytes = parsePositiveLimit(namespaceLimit);
  return namespaceBytes < ceilingBytes ? namespaceBytes : ceilingBytes;
}

function parseOptionalLimit(value: string | undefined): bigint | null {
  if (value === undefined || value === '') return null;
  return parsePositiveLimit(value);
}

export function resolveTotalLogicalBytes(
  liveFileBytes: string,
  retainedSnapshotBytes: string,
  retainedTrashBytes: string,
): bigint {
  const total =
    parseNonNegativeBytes(liveFileBytes) +
    parseNonNegativeBytes(retainedSnapshotBytes) +
    parseNonNegativeBytes(retainedTrashBytes);
  if (total > MAX_SQLITE_AND_POSTGRES_BIGINT) throw new Error('Invalid total logical byte count');
  return total;
}

export function resolveEnforcedLogicalBytes(
  liveBytes: string,
  trashBytes: string,
  snapshotBytes: string,
  excludeTrash: boolean,
  excludeSnapshots: boolean,
): bigint {
  return (
    BigInt(liveBytes) +
    (excludeTrash ? 0n : BigInt(trashBytes)) +
    (excludeSnapshots ? 0n : BigInt(snapshotBytes))
  );
}

export function assertNamespaceQuotaWithinGlobalLimit(
  namespaceLimit: string | null,
  globalBytes: bigint,
): void {
  if (namespaceLimit === null) return;
  if (parsePositiveLimit(namespaceLimit) > globalBytes) {
    throw new Error('Namespace total logical byte limit exceeds the global limit');
  }
}
