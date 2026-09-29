import { readFile } from 'node:fs/promises';
import { REQUIREMENTS_PATH } from './paths.ts';

/** 요구사항 문서의 `### RQ-NNN ...` 제목 줄에서 ID를 문서 순서대로 모은다. */
export function parseRequirementIds(markdown: string): string[] {
  return [...markdown.matchAll(/^### (RQ-\d{3})\b/gm)].map((match) => match[1]!);
}

/** `docs/requirements/file-storage.md`에 정의된 RQ ID 목록을 읽는다. */
export async function loadRequirementIds(): Promise<string[]> {
  return parseRequirementIds(await readFile(REQUIREMENTS_PATH, 'utf-8'));
}
