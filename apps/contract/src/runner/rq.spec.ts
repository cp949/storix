import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadRequirementIds, parseRequirementIds } from './rq.ts';

describe('요구사항 ID 파싱', () => {
  it('### RQ-NNN 제목 줄에서만 ID를 모은다', () => {
    const markdown = [
      '# 문서',
      '',
      '### RQ-001 호출 서버 인증',
      '',
      '본문에서 RQ-999를 언급한다.',
      '### RQ-010 순서와 재시작 후 지속성',
    ].join('\n');
    assert.deepEqual(parseRequirementIds(markdown), ['RQ-001', 'RQ-010']);
  });

  it('실제 요구사항 문서에서 RQ-005를 찾는다', async () => {
    assert.ok((await loadRequirementIds()).includes('RQ-005'));
  });
});
