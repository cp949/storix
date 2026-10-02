import { createHash } from 'node:crypto';
import type { DatasetSpec } from './spec.ts';

/** md5 해시에 version 4·variant 8 자리를 덮어쓴 UUID를 만든다. SQL의 `uuidOf`와 일치해야 한다. */
export function md5Uuid(text: string): string {
  const hex = createHash('md5').update(text, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** ACTIVE namespace 번호 `i`의 ID. */
export function activeNamespaceId(spec: DatasetSpec, i: number): string {
  return md5Uuid(`${spec.seed}:ns:${i}`);
}

/** 활동 namespace 중 `count`개를 결정적으로 고른다(균등 간격). 번호를 돌려준다. */
export function pickActiveNumbers(spec: DatasetSpec, count: number): number[] {
  const active = Math.floor(spec.namespaces / spec.activeEvery);
  if (active === 0) return [];
  const take = Math.min(count, active);
  const stride = Math.max(1, Math.floor(active / take));
  return Array.from({ length: take }, (_, k) => (1 + ((k * stride) % active)) * spec.activeEvery);
}
