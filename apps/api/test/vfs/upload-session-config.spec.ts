import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { CapabilityConfig } from '../../src/capability/capability-config.js';
import { loadUploadSessionPolicy } from '../../src/vfs/upload-session-config.js';
import { resolveUploadSessionPolicy } from '../../src/vfs/upload-session-policy.js';

const NS = '123e4567-e89b-42d3-a456-426614174000';
const enabled = {
  globalAllowedCapabilities: ['resumable-upload'],
  namespaceAllowedCapabilities: { [NS]: ['resumable-upload'] },
};

describe('upload session policy', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storix-upload-policy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 임시 정책 파일을 실제 loader로 읽고 지정한 capability 설정에 대한 검증 결과를 돌려준다. */
  async function load(value: unknown, capabilities: CapabilityConfig = enabled) {
    const path = join(dir, 'upload.json');
    await writeFile(path, JSON.stringify(value));
    return loadUploadSessionPolicy(
      new ConfigService({ STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: path }),
      capabilities,
    );
  }

  it('같은 namespace ID를 두 번 적은 정책은 시작 오류다', async () => {
    const path = join(dir, 'duplicate.json');
    const row = '{"maxStagedBytes":1048576,"maxActiveSessions":2}';
    await writeFile(path, `{"global":${row},"namespaces":{"${NS}":${row},"${NS}":${row}}}`);
    await expect(
      loadUploadSessionPolicy(new ConfigService({ STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: path }), enabled),
    ).rejects.toThrow(new RegExp(`Duplicate key "${NS}" at namespaces`));
  });

  it('disabled capability permits an absent policy', async () => {
    await expect(
      loadUploadSessionPolicy(new ConfigService({}), {
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: {},
      }),
    ).resolves.toBeNull();
  });

  it('enabled capability requires a policy', async () => {
    await expect(loadUploadSessionPolicy(new ConfigService({}), enabled)).rejects.toThrow(/policy|config/i);
    await expect(
      loadUploadSessionPolicy(new ConfigService({}), {
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: { [NS]: ['resumable-upload'] },
      }),
    ).rejects.toThrow(/policy|config/i);
  });

  it('loads finite caps and documented defaults', async () => {
    await expect(
      load({
        global: { maxStagedBytes: '104857600', maxActiveSessions: 10 },
        namespaces: { [NS]: { maxStagedBytes: '52428800', maxActiveSessions: 5 } },
      }),
    ).resolves.toEqual({
      global: {
        maxStagedBytes: 104857600n,
        maxActiveSessions: 10,
        partSizeBytes: 16777216,
        inactivitySeconds: 86400,
        maxLifetimeSeconds: 604800,
      },
      namespaces: { [NS]: { maxStagedBytes: 52428800n, maxActiveSessions: 5 } },
    });
  });

  it('전역 조각 크기가 staging 한도를 넘으면 설정 경로와 유효값을 표시한다', async () => {
    const path = join(dir, 'upload.json');
    await writeFile(
      path,
      JSON.stringify({
        global: { maxStagedBytes: '1048576', maxActiveSessions: 10, partSizeBytes: 16777216 },
        namespaces: {},
      }),
    );
    await expect(
      loadUploadSessionPolicy(new ConfigService({ STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: path }), {
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: {},
      }),
    ).rejects.toThrow(
      new RegExp(`${path}.*global\\.partSizeBytes=16777216.*global\\.maxStagedBytes=1048576`),
    );
  });

  it('기본 조각 크기도 전역 staging 한도와 비교한다', async () => {
    // 문서의 기본 조각 크기가 바뀌면 실패하도록 기대값을 리터럴로 고정한다.
    await expect(
      load({ global: { maxStagedBytes: '1048576', maxActiveSessions: 10 }, namespaces: {} }),
    ).rejects.toThrow(/16777216.*default/);
  });

  it('전역 조각 크기와 staging 한도가 같으면 허용한다', async () => {
    await expect(
      load({ global: { maxStagedBytes: '4', maxActiveSessions: 10, partSizeBytes: 4 }, namespaces: {} }),
    ).resolves.toMatchObject({ global: { partSizeBytes: 4, maxStagedBytes: 4n } });
  });

  describe('namespace 조각 크기', () => {
    const global = { maxStagedBytes: '100', maxActiveSessions: 2, partSizeBytes: 4 };
    const limits = { maxStagedBytes: '64', maxActiveSessions: 1 };

    it('생략하면 전역 조각 크기를 사용한다', async () => {
      const policy = (await load({ global, namespaces: { [NS]: limits } }))!;
      expect(policy.namespaces[NS]).toEqual({ maxStagedBytes: 64n, maxActiveSessions: 1 });
      expect(resolveUploadSessionPolicy(policy, NS).partSizeBytes).toBe(4);
      expect(resolveUploadSessionPolicy(policy, '223e4567-e89b-42d3-a456-426614174000').partSizeBytes).toBe(
        4,
      );
    });

    it('전역보다 큰 namespace 값도 허용한다', async () => {
      const policy = (await load({ global, namespaces: { [NS]: { ...limits, partSizeBytes: 64 } } }))!;
      expect(resolveUploadSessionPolicy(policy, NS).partSizeBytes).toBe(64);
    });

    it('한도 resolver는 조각 크기를 섞지 않는다', async () => {
      const policy = (await load({ global, namespaces: { [NS]: { ...limits, partSizeBytes: 64 } } }))!;
      expect(resolveUploadSessionPolicy(policy, NS).caps.namespace).toEqual({
        maxStagedBytes: 64n,
        maxActiveSessions: 1,
      });
    });

    it.each([1, 2147483647])('경계값 %d를 허용한다', async (partSizeBytes) => {
      const policy = (await load({
        global: { ...global, maxStagedBytes: String(Math.max(global.partSizeBytes, partSizeBytes)) },
        namespaces: { [NS]: { ...limits, maxStagedBytes: String(partSizeBytes), partSizeBytes } },
      }))!;
      expect(resolveUploadSessionPolicy(policy, NS).partSizeBytes).toBe(partSizeBytes);
    });

    it('namespace 조각 크기가 한도와 같으면 전역보다 큰 override를 허용한다', async () => {
      const policy = (await load({ global, namespaces: { [NS]: { ...limits, partSizeBytes: 64 } } }))!;
      expect(resolveUploadSessionPolicy(policy, NS).partSizeBytes).toBe(64);
    });

    it('명시한 namespace 조각 크기가 staging 한도를 넘으면 거부한다', async () => {
      await expect(
        load({ global, namespaces: { [NS]: { ...limits, maxStagedBytes: '10', partSizeBytes: 64 } } }),
      ).rejects.toThrow(new RegExp(`namespaces\\.${NS}.*64.*10`));
    });

    it('전역에서 상속한 조각 크기가 namespace 한도를 넘으면 출처를 표시한다', async () => {
      await expect(
        load({
          global: { maxStagedBytes: '100', maxActiveSessions: 2, partSizeBytes: 16 },
          namespaces: { [NS]: { maxStagedBytes: '10', maxActiveSessions: 1 } },
        }),
      ).rejects.toThrow(new RegExp(`namespaces\\.${NS}.*16.*global\\.partSizeBytes`));
    });

    it('기본 전역 조각 크기의 namespace 상속 출처를 표시한다', async () => {
      // 기본값 변경이 상속 경로에도 반영되는지 확인하도록 기대값을 리터럴로 고정한다.
      await expect(
        load({
          global: { maxStagedBytes: '33554432', maxActiveSessions: 2 },
          namespaces: { [NS]: { maxStagedBytes: '1048576', maxActiveSessions: 1 } },
        }),
      ).rejects.toThrow(new RegExp(`namespaces\\.${NS}.*16777216.*global\\.partSizeBytes.*default`));
    });

    it('비활성 namespace 정책도 검사한다', async () => {
      await expect(
        load(
          {
            global: { maxStagedBytes: '100', maxActiveSessions: 2, partSizeBytes: 4 },
            namespaces: { [NS]: { maxStagedBytes: '10', maxActiveSessions: 1, partSizeBytes: 64 } },
          },
          { globalAllowedCapabilities: ['resumable-upload'], namespaceAllowedCapabilities: { [NS]: [] } },
        ),
      ).rejects.toThrow(/partSizeBytes=64/);
    });

    it('모든 capability가 비활성이어도 제공된 정책을 검사한다', async () => {
      await expect(
        load(
          {
            global: { maxStagedBytes: '100', maxActiveSessions: 2, partSizeBytes: 4 },
            namespaces: { [NS]: { maxStagedBytes: '10', maxActiveSessions: 1, partSizeBytes: 64 } },
          },
          { globalAllowedCapabilities: [], namespaceAllowedCapabilities: {} },
        ),
      ).rejects.toThrow(/partSizeBytes=64/);
    });

    it('int64 staging 한도를 정밀도 손실 없이 유지한다', async () => {
      const policy = (await load({
        global: {
          maxStagedBytes: '9223372036854775807',
          maxActiveSessions: 2,
          partSizeBytes: 2147483647,
        },
        namespaces: {},
      }))!;
      expect(policy.global.maxStagedBytes).toBe(9223372036854775807n);
    });

    it.each([0, -1, 1.5, '4', null, 2147483648, Number.MAX_SAFE_INTEGER + 1])(
      '유효하지 않은 값 %j를 거부한다',
      async (partSizeBytes) => {
        await expect(load({ global, namespaces: { [NS]: { ...limits, partSizeBytes } } })).rejects.toThrow();
      },
    );

    it('조각 크기만 있는 항목은 거부한다', async () => {
      await expect(load({ global, namespaces: { [NS]: { partSizeBytes: 8 } } })).rejects.toThrow();
    });

    it('두 한도의 필수 여부와 전역 상한 검사는 유지한다', async () => {
      await expect(
        load({
          global,
          namespaces: { [NS]: { maxStagedBytes: '101', maxActiveSessions: 1, partSizeBytes: 8 } },
        }),
      ).rejects.toThrow();
      await expect(
        load({ global, namespaces: { [NS]: { maxStagedBytes: '10', partSizeBytes: 8 } } }),
      ).rejects.toThrow();
    });
  });

  it('namespace 항목이 없어도 enabled namespace의 정책을 받아들인다(전역 한도를 쓴다)', async () => {
    const policy = await load({
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 4 },
      namespaces: {},
    });
    expect(policy?.namespaces).toEqual({});
    expect(policy?.global.maxStagedBytes).toBe(100n);
  });

  it.each([
    {
      global: { maxStagedBytes: '0', maxActiveSessions: 1, partSizeBytes: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '9223372036854775808', maxActiveSessions: 1, partSizeBytes: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: Number.MAX_SAFE_INTEGER + 1, partSizeBytes: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 0 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: null },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 2147483648 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 1 },
      namespaces: { [NS]: { maxStagedBytes: '101', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 2 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1, extra: true } },
    },
  ])('rejects invalid or missing finite policy limits: %j', async (value) => {
    await expect(load(value)).rejects.toThrow();
  });

  it('rejects a lifetime that cannot be represented as a JavaScript Date', async () => {
    await expect(
      load({
        global: {
          maxStagedBytes: '16777216',
          maxActiveSessions: 1,
          inactivitySeconds: 1,
          maxLifetimeSeconds: Number.MAX_SAFE_INTEGER,
        },
        namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
      }),
    ).rejects.toThrow(/Date range/);
  });
});
