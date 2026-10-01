import type { CapabilityConfig } from './capability-config.js';
import {
  CAPABILITY_REGISTRY,
  type CapabilityDefinition,
  type CapabilityId,
  validateCapabilityRegistry,
} from './capability-registry.js';
import { VfsFeatureDisabledError } from '../vfs/vfs.errors.js';

export class CapabilityService {
  private readonly definitions: ReadonlyMap<CapabilityId, CapabilityDefinition>;
  private readonly globalAllowed: ReadonlySet<CapabilityId>;
  private readonly namespaceAllowed: ReadonlyMap<string, ReadonlySet<CapabilityId>>;
  private readonly defaultEnabled: ReadonlySet<CapabilityId>;

  constructor(config: CapabilityConfig, registry: readonly CapabilityDefinition[] = CAPABILITY_REGISTRY) {
    validateCapabilityRegistry(registry);
    this.definitions = new Map(registry.map((definition) => [definition.id, definition]));
    this.globalAllowed = new Set(config.globalAllowedCapabilities);
    this.namespaceAllowed = new Map(
      Object.entries(config.namespaceAllowedCapabilities).map(([namespaceId, ids]) => [
        namespaceId,
        new Set(ids),
      ]),
    );

    this.defaultEnabled = new Set(config.defaultEnabledCapabilities ?? []);

    for (const id of this.globalAllowed) this.requireRegistered(id);
    for (const id of this.defaultEnabled) this.requireRegistered(id, 'default');
    for (const [namespaceId, ids] of this.namespaceAllowed) {
      for (const id of ids) this.requireRegistered(id, namespaceId);
    }
    this.requireDependencies(this.defaultEnabled, 'default');
    for (const [namespaceId, ids] of this.namespaceAllowed) this.requireDependencies(ids, namespaceId);
  }

  // 목록에 든 capability의 의존이 전역 허용과 같은 목록에 모두 있어야 한다.
  private requireDependencies(ids: ReadonlySet<CapabilityId>, scope: string): void {
    for (const id of ids) {
      if (!this.globalAllowed.has(id)) continue;
      for (const dependency of this.definitions.get(id)!.dependencies) {
        if (!this.globalAllowed.has(dependency)) {
          throw new Error(`Capability dependency ${dependency} must be globally allowed for ${id}`);
        }
        if (!ids.has(dependency)) {
          throw new Error(
            `Capability dependency ${dependency} must be allowed in namespace ${scope} for ${id}`,
          );
        }
      }
    }
  }

  private requireRegistered(id: CapabilityId, namespaceId?: string): void {
    if (!this.definitions.has(id)) {
      throw new Error(`Unknown capability ID in ${namespaceId ?? 'global'} configuration: ${id}`);
    }
  }

  isEnabled(namespaceId: string, capabilityId: CapabilityId): boolean {
    const definition = this.definitions.get(capabilityId);
    if (!definition || !this.globalAllowed.has(capabilityId)) return false;
    const allowed = this.namespaceAllowed.get(namespaceId.toLowerCase()) ?? this.defaultEnabled;
    if (!allowed.has(capabilityId)) return false;
    return definition.dependencies.every((dependency) => this.isEnabled(namespaceId, dependency));
  }

  listEnabled(namespaceId: string): readonly CapabilityId[] {
    return [...this.definitions.keys()].filter((id) => this.isEnabled(namespaceId, id)).sort();
  }

  requireEnabled(namespaceId: string, capabilityId: CapabilityId): void {
    if (!this.isEnabled(namespaceId, capabilityId)) throw new VfsFeatureDisabledError(capabilityId);
  }
}
