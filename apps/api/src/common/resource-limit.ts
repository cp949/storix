export function resolveEffectiveLimit(namespaceValue: number | null, globalValue: number): number {
  // 전역값은 항상 hard ceiling이므로 비정상 값(NaN 등)도 안전한 쪽으로 처리한다
  if (namespaceValue === null || !Number.isFinite(namespaceValue)) {
    return globalValue;
  }
  return Math.min(namespaceValue, globalValue);
}
