import { isValidTimestampKey } from '../../src/common/timestamp-key.js';

describe('timestamp-key', () => {
  it.each(['2026-09-26T01:02:03.123Z', '2026-09-26T01:02:03.123456Z', '2024-02-29T23:59:59.999Z'])(
    '유효한 ISO UTC 키를 허용한다: %s',
    (key) => {
      expect(isValidTimestampKey(key)).toBe(true);
    },
  );

  it.each([
    '2026-02-30T01:02:03.123456Z',
    '2026-02-31T00:00:00.123Z',
    '2025-02-29T00:00:00.123Z',
    '0000-01-01T00:00:00.123456Z',
    '2026-13-01T00:00:00.123Z',
    '2026-09-26T24:00:00.123Z',
    '2026-09-26T01:02:03.12Z',
    '2026-09-26 01:02:03.123Z',
    '2026-09-26T01:02:03.123+09:00',
    '',
  ])('유효하지 않은 키를 거절한다: %s', (key) => {
    expect(isValidTimestampKey(key)).toBe(false);
  });
});
