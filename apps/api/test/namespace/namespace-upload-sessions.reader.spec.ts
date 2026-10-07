// NamespaceUploadSessionsReader가 `GET namespaces/{id}`의 uploadSessions 블록을 만드는 규칙을 고정한다.
// 가짜 CapabilityService·정책·저장소를 쓴다. 규칙은 docs/design/07-resumable-upload.md "설정과 만료".
import { jest } from '@jest/globals';
import type { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceUploadSessionsReader } from '../../src/namespace/namespace-upload-sessions.reader.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { UploadSessionPolicy } from '../../src/vfs/upload-session-config.js';

const ns = '11111111-1111-4111-8111-111111111111';
const overridden = '22222222-2222-4222-8222-222222222222';

const policy: UploadSessionPolicy = {
  global: {
    maxStagedBytes: 1073741824n,
    maxActiveSessions: 8,
    partSizeBytes: 16777216,
    inactivitySeconds: 86400,
    maxLifetimeSeconds: 604800,
  },
  namespaces: {
    [overridden]: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 3, partSizeBytes: 8388608 },
  },
};

/** 활성 여부·정책·사용량을 지정한 reader와 저장소 대역을 만든다. */
function build(options: { enabled?: boolean; policy?: UploadSessionPolicy | null; usage?: object } = {}) {
  const isEnabled = jest.fn<CapabilityService['isEnabled']>().mockReturnValue(options.enabled ?? true);
  const readNamespaceUsage = jest
    .fn<VfsUploadSessionRepository['readNamespaceUsage']>()
    .mockResolvedValue({ activeSessions: '2', stagedBytes: '33554432', ...options.usage });
  const reader = new NamespaceUploadSessionsReader(
    { isEnabled } as unknown as CapabilityService,
    options.policy === undefined ? policy : options.policy,
    { readNamespaceUsage } as unknown as VfsUploadSessionRepository,
  );
  return { reader, isEnabled, readNamespaceUsage };
}

// 고정된 정책·사용량으로 블록 생성과 비활성 상태의 생략을 검증한다.
describe('namespace 재개 업로드 정책·사용량 조회', () => {
  it('namespace 항목이 없으면 전역 값과 사용량을 돌려준다', async () => {
    const { reader, isEnabled } = build();
    await expect(reader.read(ns, 'ACTIVE')).resolves.toEqual({
      partSizeBytes: 16777216,
      inactivitySeconds: 86400,
      maxLifetimeSeconds: 604800,
      maxStagedBytes: '1073741824',
      maxActiveSessions: 8,
      stagedBytes: '33554432',
      activeSessions: 2,
    });
    expect(isEnabled).toHaveBeenCalledWith(ns, 'resumable-upload');
  });

  it('namespace 항목이 있으면 조각 크기와 한도를 그 값으로 돌려주고 수명은 전역 값이다', async () => {
    const { reader } = build();
    await expect(reader.read(overridden, 'ACTIVE')).resolves.toMatchObject({
      partSizeBytes: 8388608,
      maxStagedBytes: '9007199254740993',
      maxActiveSessions: 3,
      inactivitySeconds: 86400,
      maxLifetimeSeconds: 604800,
    });
  });

  it('바이트 한도·사용량은 int64 문자열이고 조각 크기·초·개수는 정수다', async () => {
    const { reader } = build({ usage: { stagedBytes: '9007199254740993' } });
    const block = await reader.read(overridden, 'ACTIVE');
    expect(typeof block?.maxStagedBytes).toBe('string');
    expect(block?.stagedBytes).toBe('9007199254740993');
    for (const field of [
      'partSizeBytes',
      'inactivitySeconds',
      'maxLifetimeSeconds',
      'maxActiveSessions',
      'activeSessions',
    ] as const)
      expect(Number.isInteger(block?.[field])).toBe(true);
  });

  it('resumable-upload가 비활성이면 생략하고 사용량을 읽지 않는다', async () => {
    const { reader, readNamespaceUsage } = build({ enabled: false });
    await expect(reader.read(ns, 'ACTIVE')).resolves.toBeNull();
    expect(readNamespaceUsage).not.toHaveBeenCalled();
  });

  it('정책이 없으면 생략한다', async () => {
    const { reader, readNamespaceUsage } = build({ policy: null });
    await expect(reader.read(ns, 'ACTIVE')).resolves.toBeNull();
    expect(readNamespaceUsage).not.toHaveBeenCalled();
  });

  it.each(['DELETING', 'DELETED'])('%s namespace는 생략한다', async (status) => {
    const { reader, readNamespaceUsage } = build();
    await expect(reader.read(ns, status)).resolves.toBeNull();
    expect(readNamespaceUsage).not.toHaveBeenCalled();
  });
});
