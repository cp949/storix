import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCapabilitiesConfig } from './provision.ts';

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
