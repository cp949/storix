import { randomInt } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Contract, ProfileName } from '../define-contract.ts';

/** 발견한 계약과 그 파일 경로. */
export interface DiscoveredContract {
  readonly contract: Contract;
  readonly file: string;
}

function isContract(value: unknown): value is Contract {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'contract';
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 디렉터리 아래 모든 `.ts` 파일을 파일 이름 순서로 import해 default export 계약을 모은다.
 * 등록 목록을 따로 두지 않으므로 파일을 추가하면 실행 대상이 된다.
 */
export async function discoverContracts(rootDir: string): Promise<DiscoveredContract[]> {
  const discovered: DiscoveredContract[] = [];
  for (const file of await listTypeScriptFiles(rootDir)) {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (!isContract(module.default)) {
      throw new Error(`${file}: default export가 defineContract() 결과가 아니다.`);
    }
    discovered.push({ contract: module.default, file });
  }
  return discovered;
}

/** id 중복과 요구사항 문서에 없는 RQ를 오류 메시지 목록으로 돌려준다. */
export function validateContracts(
  discovered: readonly DiscoveredContract[],
  knownRqIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const filesById = new Map<string, string[]>();
  for (const { contract, file } of discovered) {
    filesById.set(contract.id, [...(filesById.get(contract.id) ?? []), file]);
    for (const rq of contract.rq) {
      if (!knownRqIds.has(rq)) {
        errors.push(`${contract.id}: 요구사항 문서에 없는 RQ ID ${rq}`);
      }
    }
  }
  for (const [id, files] of filesById) {
    if (files.length > 1) {
      errors.push(`계약 id 중복: ${id} (${files.join(', ')})`);
    }
  }
  return errors;
}

/** 지정한 id의 계약만 고른다. id를 생략하면 전체다. 없는 id는 오류다. */
export function selectContracts(contracts: readonly Contract[], ids: readonly string[]): Contract[] {
  if (ids.length === 0) return [...contracts];
  return ids.map((id) => {
    const found = contracts.find((contract) => contract.id === id);
    if (!found) throw new Error(`계약을 찾을 수 없다: ${id}`);
    return found;
  });
}

/** 프로필별로 묶는다. 프로필과 계약 모두 입력 순서를 유지한다. */
export function groupByProfile(contracts: readonly Contract[]): Map<ProfileName, Contract[]> {
  const groups = new Map<ProfileName, Contract[]>();
  for (const contract of contracts) {
    groups.set(contract.profile, [...(groups.get(contract.profile) ?? []), contract]);
  }
  return groups;
}

/**
 * Fisher-Yates로 섞은 복사본을 돌려준다. 입력은 바꾸지 않는다.
 * `pickIndex(bound)`는 0 이상 bound 미만의 정수를 돌려준다. 기본값은 `crypto.randomInt`다.
 */
export function shuffle<T>(items: readonly T[], pickIndex: (bound: number) => number = randomInt): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = pickIndex(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** 계약이 하나도 참조하지 않는 RQ를 문서 순서로 돌려준다. */
export function findUncoveredRqs(knownRqIds: readonly string[], contracts: readonly Contract[]): string[] {
  const covered = new Set(contracts.flatMap((contract) => contract.rq));
  return knownRqIds.filter((id) => !covered.has(id));
}
