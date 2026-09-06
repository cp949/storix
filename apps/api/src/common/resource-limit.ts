export function resolveEffectiveLimit(namespaceValue: number | null, globalValue: number): number {
  if (namespaceValue === null) {
    return globalValue;
  }
  return Math.min(namespaceValue, globalValue);
}
