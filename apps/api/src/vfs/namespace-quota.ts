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

export function resolveNamespaceQuota(
  namespaceLimit: string | null,
  globalLimit: string | undefined = process.env.STORIX_MAX_TOTAL_LOGICAL_BYTES,
): bigint {
  const globalBytes = resolveGlobalTotalLogicalByteLimit(globalLimit);
  if (namespaceLimit === null) return globalBytes;
  const namespaceBytes = parsePositiveLimit(namespaceLimit);
  return namespaceBytes < globalBytes ? namespaceBytes : globalBytes;
}

export function resolveTotalLogicalBytes(liveFileBytes: string, retainedSnapshotBytes: string): bigint {
  const total = parseNonNegativeBytes(liveFileBytes) + parseNonNegativeBytes(retainedSnapshotBytes);
  if (total > MAX_SQLITE_AND_POSTGRES_BIGINT) throw new Error('Invalid total logical byte count');
  return total;
}

export function assertNamespaceQuotaWithinGlobalLimit(
  namespaceLimit: string | null,
  globalLimit: string | undefined = process.env.STORIX_MAX_TOTAL_LOGICAL_BYTES,
): void {
  if (namespaceLimit === null) return;
  if (parsePositiveLimit(namespaceLimit) > resolveGlobalTotalLogicalByteLimit(globalLimit)) {
    throw new Error('Namespace total logical byte limit exceeds the global limit');
  }
}
