import {
  parseUploadSessionPolicy,
  resolveNamespaceUploadLimits,
} from '../../src/vfs/upload-session-config.js';

const NS = '123e4567-e89b-42d3-a456-426614174000';
const GLOBAL = { maxStagedBytes: '1000', maxActiveSessions: 10, partSizeBytes: 4 };

describe('업로드 세션 정책', () => {
  it('namespace 항목이 없어도 정책을 받는다', () => {
    const policy = parseUploadSessionPolicy({ global: GLOBAL, namespaces: {} });
    expect(policy.namespaces).toEqual({});
  });

  it('namespace 항목이 전역 한도를 넘으면 거부한다', () => {
    expect(() =>
      parseUploadSessionPolicy({
        global: GLOBAL,
        namespaces: { [NS]: { maxStagedBytes: '2000', maxActiveSessions: 1 } },
      }),
    ).toThrow(/exceeds global/);
  });

  it('namespace ID 표기가 정확히 일치할 때만 override를 사용한다', () => {
    const policy = parseUploadSessionPolicy({
      global: GLOBAL,
      namespaces: { [NS]: { maxStagedBytes: '500', maxActiveSessions: 2 } },
    });
    expect(resolveNamespaceUploadLimits(policy, NS)).toEqual({
      maxStagedBytes: 500n,
      maxActiveSessions: 2,
    });
    expect(resolveNamespaceUploadLimits(policy, NS.toUpperCase())).toEqual({
      maxStagedBytes: 1000n,
      maxActiveSessions: 10,
    });
    expect(resolveNamespaceUploadLimits(policy, '123e4567-e89b-42d3-a456-426614174001')).toEqual({
      maxStagedBytes: 1000n,
      maxActiveSessions: 10,
    });
  });
});
