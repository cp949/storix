const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function resolveLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_LIMIT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}
