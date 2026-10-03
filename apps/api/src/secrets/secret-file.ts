import { readFile } from 'node:fs/promises';

/** 끝의 줄바꿈 하나(`\r\n` 또는 `\n`)만 제거한다. 그 밖의 공백은 보존한다. */
export function stripOneTrailingNewline(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }
  if (value.endsWith('\n')) {
    return value.slice(0, -1);
  }
  return value;
}

/** `X_FILE` 경로의 파일을 UTF-8로 읽고 끝 줄바꿈 하나를 제거한다. */
export async function readSecretFile(path: string): Promise<string> {
  return stripOneTrailingNewline(await readFile(path, 'utf8'));
}
