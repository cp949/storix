import assert from 'node:assert/strict';
import type { ContractContext } from '../define-contract.ts';

/** extract 요청 본문의 공통 필드. */
export interface StagedArchive {
  readonly source: string;
  readonly sourceRevision: string;
}

/** 파일의 부모 DIRECTORY를 만든다. root는 이미 있으므로 건너뛴다. */
async function makeParents(ctx: ContractContext, namespaceId: string, filePath: string): Promise<void> {
  const directory = filePath.slice(0, filePath.lastIndexOf('/'));
  if (directory === '') return;
  const made = await ctx.client.mkdir(namespaceId, directory, true);
  assert.ok(made.status < 300, made.text());
}

/**
 * 압축 FILE을 namespace에 올리고 extract 요청의 `source`·`sourceRevision`을 돌려준다.
 * 부모 DIRECTORY는 `mkdir`로 먼저 만든다. 조건부 콘텐츠 저장은 부모를 만들지 않는다.
 */
export async function stageArchive(
  ctx: ContractContext,
  namespaceId: string,
  archive: Buffer,
  filePath = '/.staging/archive.bin',
): Promise<StagedArchive> {
  await makeParents(ctx, namespaceId, filePath);
  const saved = await ctx.client.putConditionalContent(namespaceId, filePath, archive, { ifAbsent: true });
  assert.equal(saved.status, 201, saved.text());
  const stat = await ctx.client.getStat(namespaceId, filePath);
  assert.equal(stat.status, 200, stat.text());
  return { source: filePath, sourceRevision: stat.json<{ revision: string }>().revision };
}

/** 경로에 FILE을 새로 만든다. 부모 DIRECTORY도 함께 만든다. */
export async function putFile(
  ctx: ContractContext,
  namespaceId: string,
  filePath: string,
  content: string,
): Promise<void> {
  await makeParents(ctx, namespaceId, filePath);
  const saved = await ctx.client.putConditionalContent(namespaceId, filePath, Buffer.from(content), {
    ifAbsent: true,
  });
  assert.equal(saved.status, 201, saved.text());
}

/** FILE 내용을 UTF-8 문자열로 읽는다. 200이 아니면 실패한다. */
export async function readFileText(
  ctx: ContractContext,
  namespaceId: string,
  filePath: string,
): Promise<string> {
  const response = await ctx.client.getContent(namespaceId, filePath);
  assert.equal(response.status, 200, `${filePath}: ${response.text()}`);
  return response.text();
}
