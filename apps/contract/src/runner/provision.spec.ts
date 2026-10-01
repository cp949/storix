import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { UPLOAD_SESSION_POLICY } from './profiles.ts';
import {
  buildCapabilitiesConfig,
  buildUploadSessionsConfig,
  provisionCapabilityNamespaces,
} from './provision.ts';

describe('capability 설정 생성(buildCapabilitiesConfig)', () => {
  it('전역과 각 namespace에 같은 capability를 허용한다', () => {
    const config = buildCapabilitiesConfig(['change-feed'], ['id-1', 'id-2']);
    assert.deepEqual(config, {
      globalAllowedCapabilities: ['change-feed'],
      namespaceAllowedCapabilities: { 'id-1': ['change-feed'], 'id-2': ['change-feed'] },
    });
  });

  it('namespace가 없으면 namespace 항목이 비어 있다', () => {
    assert.deepEqual(buildCapabilitiesConfig(['change-feed'], []).namespaceAllowedCapabilities, {});
  });

  it('입력 배열을 변경하지 않고 복사해 담는다', () => {
    const capabilities = ['change-feed'];
    const config = buildCapabilitiesConfig(capabilities, ['id-1']);
    capabilities.push('resumable-upload');
    assert.deepEqual(config.globalAllowedCapabilities, ['change-feed']);
  });
});

describe('세션 정책 설정 생성(buildUploadSessionsConfig)', () => {
  it('전역 정책을 그대로 담고 각 namespace에 같은 상한을 준다', () => {
    const config = buildUploadSessionsConfig(UPLOAD_SESSION_POLICY, ['id-1', 'id-2']);
    assert.deepEqual(config.global, {
      maxStagedBytes: UPLOAD_SESSION_POLICY.maxStagedBytes,
      maxActiveSessions: UPLOAD_SESSION_POLICY.maxActiveSessions,
      partSizeBytes: UPLOAD_SESSION_POLICY.partSizeBytes,
    });
    const namespacePolicy = {
      maxStagedBytes: UPLOAD_SESSION_POLICY.maxStagedBytes,
      maxActiveSessions: UPLOAD_SESSION_POLICY.maxActiveSessions,
    };
    assert.deepEqual(config.namespaces, { 'id-1': namespacePolicy, 'id-2': namespacePolicy });
  });

  it('namespace 상한은 서버가 요구하는 대로 전역 상한 이하다', () => {
    const config = buildUploadSessionsConfig(UPLOAD_SESSION_POLICY, ['id-1']);
    assert.ok(BigInt(config.namespaces['id-1'].maxStagedBytes) <= BigInt(config.global.maxStagedBytes));
    assert.ok(config.namespaces['id-1'].maxActiveSessions <= config.global.maxActiveSessions);
  });

  it('namespace가 없으면 namespace 항목이 비어 있다', () => {
    assert.deepEqual(buildUploadSessionsConfig(UPLOAD_SESSION_POLICY, []).namespaces, {});
  });
});

describe('capability provisioning의 재시작 준비 훅', () => {
  it('설정을 쓴 뒤 재시작 전에 만든 namespace를 넘겨 호출한다', async (test) => {
    const effects: string[] = [];
    const fetchRequest: typeof fetch = async () => {
      effects.push('namespace');
      return new Response(JSON.stringify({ id: `id-${effects.length}`, name: 'name' }), { status: 201 });
    };
    const created = await provisionCapabilityNamespaces(
      {
        baseUrl: 'http://example.test',
        apiKey: 'key',
        signal: new AbortController().signal,
        capabilities: ['resumable-upload'],
        count: 2,
        configPath: '/unused/config.json',
        async prepareRestart(namespaces) {
          effects.push(`prepare:${namespaces.map((namespace) => namespace.id).join(',')}`);
        },
        async restart() {
          effects.push('restart');
        },
      },
      {
        fetch: fetchRequest,
        async writeCapabilitiesConfig() {
          effects.push('write');
        },
      },
    );
    test.diagnostic(`namespace ${created.length}개`);
    assert.deepEqual(effects, ['namespace', 'namespace', 'write', 'prepare:id-1,id-2', 'restart']);
  });
});

// 각 await 뒤 새 namespace·설정 쓰기·restart를 시작하지 않는 경계를 고정한다.
describe('capability provisioning 취소', () => {
  for (const phase of ['before', 'namespace', 'write'] as const) {
    it(`${phase}에서 취소되면 뒤 부수 효과를 시작하지 않는다`, async (test) => {
      const controller = new AbortController();
      const effects: string[] = [];
      const directory = await mkdtemp(path.join(tmpdir(), 'storix-provision-spec-'));
      test.after(() => rm(directory, { recursive: true, force: true }));
      const fetchRequest: typeof fetch = async () => {
        effects.push('namespace');
        if (phase === 'namespace') controller.abort();
        return new Response(JSON.stringify({ id: 'id', name: 'name' }), { status: 201 });
      };
      // 의존성 주입 전 구현에도 같은 HTTP 응답을 제공해 취소 누락 자체를 재현한다.
      test.mock.method(globalThis, 'fetch', fetchRequest);
      if (phase === 'before') controller.abort();
      await assert.rejects(
        provisionCapabilityNamespaces(
          {
            baseUrl: 'http://example.test',
            apiKey: 'key',
            signal: controller.signal,
            capabilities: ['change-feed'],
            count: 2,
            configPath: path.join(directory, 'config.json'),
            async restart() {
              effects.push('restart');
            },
          },
          {
            fetch: fetchRequest,
            async writeCapabilitiesConfig() {
              effects.push('write');
              if (phase === 'write') controller.abort();
            },
          },
        ),
        { name: 'AbortError' },
      );
      assert.deepEqual(
        effects,
        phase === 'before' ? [] : phase === 'namespace' ? ['namespace'] : ['namespace', 'namespace', 'write'],
      );
    });
  }
});
