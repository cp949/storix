import {
  CAPABILITY_REGISTRY,
  type CapabilityDefinition,
  validateCapabilityRegistry,
} from './capability-registry.js';
import { CapabilityService } from './capability.service.js';

const feature: CapabilityDefinition = {
  id: 'content-search',
  scope: 'namespace',
  defaultEnabled: false,
  precedence: 'global-ceiling-then-namespace-opt-in',
  dependencies: [],
  disabledBehavior: 'VFS_FEATURE_DISABLED',
  dataHandling: 'preserve-query-export-recover-delete',
  discoveryVisibility: 'effective-state',
};

describe('capability registry', () => {
  it('resumable-upload는 기본 비활성 namespace capability로 등록된다', () => {
    expect(CAPABILITY_REGISTRY).toEqual([{ ...feature, id: 'resumable-upload' }]);
    const namespaceId = '11111111-1111-4111-8111-111111111111';
    const disabled = new CapabilityService({
      globalAllowedCapabilities: [],
      namespaceAllowedCapabilities: {},
    });
    expect(disabled.listEnabled(namespaceId)).toEqual([]);
    expect(disabled.isEnabled(namespaceId, 'resumable-upload')).toBe(false);
    expect(() => disabled.requireEnabled(namespaceId, 'resumable-upload')).toThrow(/resumable-upload/);
    const enabled = new CapabilityService({
      globalAllowedCapabilities: ['resumable-upload'],
      namespaceAllowedCapabilities: { [namespaceId]: ['resumable-upload'] },
    });
    expect(enabled.listEnabled(namespaceId)).toEqual(['resumable-upload']);
  });

  it('필수 메타데이터 누락과 잘못된 값을 거부한다', () => {
    for (const key of Object.keys(feature) as (keyof CapabilityDefinition)[]) {
      const missing = { ...feature } as Record<string, unknown>;
      delete missing[key];
      expect(() => validateCapabilityRegistry([missing])).toThrow(/metadata|registry|capability/i);
    }
    expect(() => validateCapabilityRegistry([{ ...feature, id: 'Content-Search' }])).toThrow();
    expect(() => validateCapabilityRegistry([{ ...feature, defaultEnabled: true }])).toThrow();
    expect(() => validateCapabilityRegistry([{ ...feature, scope: 'global' }])).toThrow();
  });

  it('중복 ID를 거부한다', () => {
    expect(() => validateCapabilityRegistry([feature, { ...feature }])).toThrow(/duplicate|중복/i);
  });

  it('미등록 의존성과 자기 의존을 거부한다', () => {
    expect(() => validateCapabilityRegistry([{ ...feature, dependencies: ['missing-feature'] }])).toThrow(
      /depend|의존/i,
    );
    expect(() => validateCapabilityRegistry([{ ...feature, dependencies: ['content-search'] }])).toThrow(
      /depend|의존/i,
    );
  });

  it('간접 순환 의존을 거부한다', () => {
    expect(() =>
      validateCapabilityRegistry([
        { ...feature, dependencies: ['metadata-index'] },
        { ...feature, id: 'metadata-index', dependencies: ['file-preview'] },
        { ...feature, id: 'file-preview', dependencies: ['content-search'] },
      ]),
    ).toThrow(/cycle|순환/i);
  });

  it('등록된 비순환 의존은 허용한다', () => {
    expect(() =>
      validateCapabilityRegistry([
        feature,
        { ...feature, id: 'file-preview', dependencies: ['content-search'] },
      ]),
    ).not.toThrow();
  });
});
