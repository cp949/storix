const DEFAULT_MAX_RETAINED_TRASH_NODES = 100000;

export function resolveTrashRetentionNodeLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RETAINED_TRASH_NODES;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid trash retention node limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) throw new Error('Invalid trash retention node limit');
  return limit;
}
