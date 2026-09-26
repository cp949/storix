import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { loadCapabilityConfig } from './capability-config.js';

const NAMESPACE_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('capability 시작 설정', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storix-capability-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function loadFile(value: unknown) {
    const path = join(dir, 'capabilities.json');
    await writeFile(path, JSON.stringify(value));
    return loadCapabilityConfig(new ConfigService({ STORIX_VFS_CAPABILITIES_CONFIG_PATH: path }));
  }

  it('경로가 없으면 두 허용 목록이 비어 있다', async () => {
    await expect(loadCapabilityConfig(new ConfigService({}))).resolves.toEqual({
      globalAllowedCapabilities: [],
      namespaceAllowedCapabilities: {},
    });
  });

  it('올바른 전역 및 namespace 허용 목록을 읽는다', async () => {
    await expect(
      loadFile({
        globalAllowedCapabilities: ['content-search'],
        namespaceAllowedCapabilities: { [NAMESPACE_ID]: ['content-search'] },
      }),
    ).resolves.toEqual({
      globalAllowedCapabilities: ['content-search'],
      namespaceAllowedCapabilities: { [NAMESPACE_ID]: ['content-search'] },
    });
  });

  it('대문자 namespace UUID 키를 DB 조회용 소문자 정규형으로 반환한다', async () => {
    await expect(
      loadFile({
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: { [NAMESPACE_ID.toUpperCase()]: [] },
      }),
    ).resolves.toEqual({
      globalAllowedCapabilities: [],
      namespaceAllowedCapabilities: { [NAMESPACE_ID]: [] },
    });
  });

  it('같은 namespace UUID의 대소문자 표기가 중복되면 목록 덮어쓰기를 거부한다', async () => {
    await expect(
      loadFile({
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: {
          [NAMESPACE_ID]: ['first-capability'],
          [NAMESPACE_ID.toUpperCase()]: ['second-capability'],
        },
      }),
    ).rejects.toThrow(/duplicate|중복/i);
  });

  it('지정 파일을 읽을 수 없으면 실패한다', async () => {
    await expect(
      loadCapabilityConfig(new ConfigService({ STORIX_VFS_CAPABILITIES_CONFIG_PATH: join(dir, 'missing.json') })),
    ).rejects.toThrow(/capabilit|설정/i);
  });

  it('잘못된 JSON이면 실패한다', async () => {
    const path = join(dir, 'invalid.json');
    await writeFile(path, '{');
    await expect(loadCapabilityConfig(new ConfigService({ STORIX_VFS_CAPABILITIES_CONFIG_PATH: path }))).rejects.toThrow(
      /JSON/,
    );
  });

  it.each([
    [{ globalAllowedCapabilities: [], namespaceAllowedCapabilities: {}, extra: true }, '알 수 없는 최상위 key'],
    [{ globalAllowedCapabilities: 'content-search', namespaceAllowedCapabilities: {} }, '전역 목록 타입'],
    [{ globalAllowedCapabilities: [1], namespaceAllowedCapabilities: {} }, '전역 항목 타입'],
    [{ globalAllowedCapabilities: ['Content-Search'], namespaceAllowedCapabilities: {} }, 'capability 식별자 형식'],
    [{ globalAllowedCapabilities: [], namespaceAllowedCapabilities: [] }, 'namespace map 타입'],
    [{ globalAllowedCapabilities: [], namespaceAllowedCapabilities: { invalid: [] } }, 'namespace UUID 형식'],
    [{ globalAllowedCapabilities: [], namespaceAllowedCapabilities: { [NAMESPACE_ID]: 'content-search' } }, 'namespace 목록 타입'],
    [{ globalAllowedCapabilities: [], namespaceAllowedCapabilities: { [NAMESPACE_ID]: [1] } }, 'namespace 항목 타입'],
    [{ globalAllowedCapabilities: [] }, '필수 key 누락'],
  ])('%s 설정은 거부한다: %s', async (value, _reason) => {
    await expect(loadFile(value)).rejects.toThrow();
  });
});
