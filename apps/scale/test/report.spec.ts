import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderReport, type ReportInput } from '../src/report.ts';

const ok = (data: Record<string, unknown>) => ({ ok: true, error: null, data });

function result(overrides: Partial<ReportInput['phases']> = {}): ReportInput {
  return {
    runId: 'r1',
    label: 'sqlite',
    spec: { namespaces: 1000 },
    phases: {
      startup: ok({ startupMs: 1200, readyRssBytes: 104857600 }),
      gc: ok({ wallMs: 30, peakRssBytes: 52428800 }),
      requests: ok({
        peakRssBytes: 62914560,
        results: { stat: { p50Ms: 1, p95Ms: 2, count: 10, failures: 0, throughputPerSec: 100 } },
      }),
      ...overrides,
    },
  };
}

/** 마크다운 표 한 줄의 셀 수. 이스케이프한 `\|`는 셀 구분이 아니다. */
function cellCount(line: string): number {
  return line.replace(/\\\|/g, '').split('|').length - 2;
}

function tables(markdown: string): string[][] {
  return markdown
    .split('\n\n')
    .map((block) => block.split('\n'))
    .filter((lines) => lines[0].startsWith('|'));
}

describe('renderReport', () => {
  it('모든 표에서 헤더·구분선·행의 열 수가 같다', () => {
    const markdown = renderReport([result(), { ...result(), label: 'postgres' }]);
    const found = tables(markdown);
    assert.equal(found.length, 2);
    for (const lines of found) {
      const expected = cellCount(lines[0]);
      for (const line of lines) assert.equal(cellCount(line), expected, line);
    }
  });

  it('실패 메시지의 `|`는 표 열을 깨지 않도록 이스케이프한다', () => {
    const failed = result({
      startup: { ok: false, error: 'bad | pipe\nsecond line', data: null },
      list: ok({ first: { ok: false, error: 'status a|b', status: 500 }, peakRssBytes: 1 }),
    });
    const markdown = renderReport([failed]);
    const [header, , row] = tables(markdown)[0];
    assert.equal(cellCount(row), cellCount(header), row);
    assert.match(row, /bad \\\| pipe/);
    assert.match(row, /status a\\\|b/);
  });
});
