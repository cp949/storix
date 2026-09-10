import { describe, expect, it } from 'vitest';
import { joinPath } from './path';

describe('joinPath', () => {
  it('root(/)에서는 파일명 앞에 슬래시 하나만 붙인다', () => {
    expect(joinPath('/', 'a.txt')).toBe('/a.txt');
  });

  it('하위 경로에서는 경로와 파일명을 슬래시로 잇는다', () => {
    expect(joinPath('/reports', 'a.txt')).toBe('/reports/a.txt');
  });
});
