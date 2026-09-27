const MAX_SQLITE_AND_POSTGRES_BIGINT = 9223372036854775807n;
const DEFAULT_MAX_TOTAL_LOGICAL_BYTES = 53687091200n;

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
  if (value === undefined || value === '') return DEFAULT_MAX_TOTAL_LOGICAL_BYTES;
  return parsePositiveLimit(value);
}

// globalBytes는 호출자가 부팅 시 ConfigService 값을 resolveGlobalTotalLogicalByteLimit로 해석해 넘긴다
export function resolveNamespaceQuota(namespaceLimit: string | null, globalBytes: bigint): bigint {
  if (namespaceLimit === null) return globalBytes;
  const namespaceBytes = parsePositiveLimit(namespaceLimit);
  return namespaceBytes < globalBytes ? namespaceBytes : globalBytes;
}

export function resolveTotalLogicalBytes(liveFileBytes: string, retainedSnapshotBytes: string, retainedTrashBytes: string): bigint {
  const total = parseNonNegativeBytes(liveFileBytes) + parseNonNegativeBytes(retainedSnapshotBytes)
    + parseNonNegativeBytes(retainedTrashBytes);
  if (total > MAX_SQLITE_AND_POSTGRES_BIGINT) throw new Error('Invalid total logical byte count');
  return total;
}

export function assertNamespaceQuotaWithinGlobalLimit(namespaceLimit: string | null, globalBytes: bigint): void {
  if (namespaceLimit === null) return;
  if (parsePositiveLimit(namespaceLimit) > globalBytes) {
    throw new Error('Namespace total logical byte limit exceeds the global limit');
  }
}
