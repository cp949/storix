import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => [key, canonicalize(entryValue)] as const);

    return Object.fromEntries(sortedEntries);
  }

  return value;
}

export function canonicalJsonHash(value: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(value));
  return createHash('sha256').update(canonicalJson).digest('hex');
}
