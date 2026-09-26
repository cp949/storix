import type { CapabilityConfig } from './capability-config.js';
import type { CapabilityDefinition } from './capability-registry.js';
import { CapabilityService } from './capability.service.js';

const NS = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_NS = '123e4567-e89b-42d3-a456-426614174001';
const search: CapabilityDefinition = {
  id: 'content-search', scope: 'namespace', defaultEnabled: false,
  precedence: 'global-ceiling-then-namespace-opt-in', dependencies: [],
  disabledBehavior: 'VFS_FEATURE_DISABLED', dataHandling: 'preserve-query-export-recover-delete',
  discoveryVisibility: 'effective-state',
};
const preview: CapabilityDefinition = { ...search, id: 'file-preview', dependencies: ['content-search'] };

function config(global: string[] = [], namespaces: Record<string, string[]> = {}): CapabilityConfig {
  return { globalAllowedCapabilities: global, namespaceAllowedCapabilities: namespaces };
}

describe('CapabilityService', () => {
  it('설정 누락이면 선택 기능을 비활성화한다', () => {
    expect(new CapabilityService(config(), [search]).isEnabled(NS, 'content-search')).toBe(false);
  });

  it('전역 허용만으로는 namespace 기능을 켜지 않는다', () => {
    expect(new CapabilityService(config(['content-search']), [search]).isEnabled(NS, 'content-search')).toBe(false);
  });

  it('전역 허용만 있고 namespace opt-in이 없으면 의존 기능이 없어도 시작한다', () => {
    const service = new CapabilityService(config(['file-preview']), [search, preview]);
    expect(service.isEnabled(NS, 'file-preview')).toBe(false);
  });

  it('namespace 허용은 전역 상한을 넘지 못한다', () => {
    expect(new CapabilityService(config([], { [NS]: ['content-search'] }), [search]).isEnabled(NS, 'content-search')).toBe(false);
  });

  it('전역과 해당 namespace가 모두 허용하면 해당 namespace에서만 켠다', () => {
    const service = new CapabilityService(config(['content-search'], { [NS]: ['content-search'] }), [search]);
    expect(service.isEnabled(NS, 'content-search')).toBe(true);
    expect(service.isEnabled(OTHER_NS, 'content-search')).toBe(false);
  });

  it('활성 ID 목록은 설정 누락, 전역 허용만, namespace 허용만이면 비어 있다', () => {
    expect(new CapabilityService(config(), [search]).listEnabled(NS)).toEqual([]);
    expect(new CapabilityService(config(['content-search']), [search]).listEnabled(NS)).toEqual([]);
    expect(new CapabilityService(config([], { [NS]: ['content-search'] }), [search]).listEnabled(NS)).toEqual([]);
  });

  it('활성 ID 목록은 의존 기능을 포함해 사전순으로 반환한다', () => {
    const service = new CapabilityService(
      config(['content-search', 'file-preview'], { [NS]: ['content-search', 'file-preview'] }),
      [preview, search],
    );

    expect(service.listEnabled(NS)).toEqual(['content-search', 'file-preview']);
    expect(service.listEnabled(OTHER_NS)).toEqual([]);
  });

  it('미등록 ID가 전역 또는 namespace 설정에 있으면 시작 시 거부한다', () => {
    expect(() => new CapabilityService(config(['missing-feature']), [search])).toThrow(/unknown|unregistered|미등록/i);
    expect(() => new CapabilityService(config([], { [NS]: ['missing-feature'] }), [search])).toThrow(/unknown|unregistered|미등록/i);
    expect(() => new CapabilityService(config(['content-search']))).toThrow(/unknown|unregistered|미등록/i);
  });

  it('registry 중복은 시작 시 거부한다', () => {
    expect(() => new CapabilityService(config(), [search, { ...search }])).toThrow(/duplicate|중복/i);
  });

  it('활성 capability의 전역 의존이 없으면 시작 시 거부한다', () => {
    expect(() => new CapabilityService(config(['file-preview'], { [NS]: ['file-preview'] }), [search, preview])).toThrow(/depend|의존/i);
  });

  it('활성 capability의 namespace 의존이 없으면 시작 시 거부한다', () => {
    expect(() => new CapabilityService(config(['content-search', 'file-preview'], { [NS]: ['file-preview'] }), [search, preview])).toThrow(/depend|의존/i);
  });

  it('의존 기능을 자동 활성화하지 않는다', () => {
    const service = new CapabilityService(config(['content-search', 'file-preview'], { [NS]: ['content-search', 'file-preview'] }), [search, preview]);
    expect(service.isEnabled(NS, 'file-preview')).toBe(true);
    expect(service.isEnabled(NS, 'content-search')).toBe(true);
    expect(service.isEnabled(OTHER_NS, 'content-search')).toBe(false);
  });

  it('비활성 기능을 요구하면 식별자가 포함된 409 VFS_FEATURE_DISABLED를 던진다', () => {
    const service = new CapabilityService(config(), [search]);
    expect(() => service.requireEnabled(NS, 'content-search')).toThrow(expect.objectContaining({
      code: 'VFS_FEATURE_DISABLED', status: 409, message: expect.stringContaining('content-search'),
    }));
  });
});
