import { buildContentDisposition } from './content-disposition.js';

describe('buildContentDisposition', () => {
  it('ASCII 파일명은 그대로 사용한다', () => {
    expect(buildContentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('한글 파일명은 ASCII fallback을 밑줄로 대체하고 filename*에 인코딩해 담는다', () => {
    expect(buildContentDisposition('보고서.pdf')).toBe(
      `attachment; filename="___.pdf"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf`,
    );
  });

  it('따옴표와 역슬래시는 fallback에서 밑줄로 치환한다', () => {
    expect(buildContentDisposition('a"b\\c.txt')).toContain('filename="a_b_c.txt"');
  });

  it('CR/LF 등 제어 문자를 포함한 파일명은 fallback과 encoded 값 모두에서 안전하게 처리한다', () => {
    const header = buildContentDisposition('evil\r\nname.txt');
    expect(header).not.toMatch(/[\r\n]/);
  });
});
