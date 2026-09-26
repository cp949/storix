export type CapabilityId = string;

export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly scope: 'namespace';
  readonly defaultEnabled: false;
  readonly precedence: 'global-ceiling-then-namespace-opt-in';
  readonly dependencies: readonly CapabilityId[];
  readonly disabledBehavior: 'VFS_FEATURE_DISABLED';
  readonly dataHandling: 'preserve-query-export-recover-delete';
  readonly discoveryVisibility: 'effective-state';
}

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [];

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const METADATA: Readonly<Record<Exclude<keyof CapabilityDefinition, 'id' | 'dependencies'>, string | boolean>> = {
  scope: 'namespace',
  defaultEnabled: false,
  precedence: 'global-ceiling-then-namespace-opt-in',
  disabledBehavior: 'VFS_FEATURE_DISABLED',
  dataHandling: 'preserve-query-export-recover-delete',
  discoveryVisibility: 'effective-state',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCapabilityRegistry(registry: readonly unknown[]): void {
  const definitions = new Map<string, CapabilityDefinition>();
  for (const value of registry) {
    if (!isRecord(value) || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
      throw new Error('Invalid capability registry metadata: id');
    }
    for (const [key, expected] of Object.entries(METADATA)) {
      if (value[key] !== expected) throw new Error(`Invalid capability registry metadata: ${value.id}.${key}`);
    }
    if (!Array.isArray(value.dependencies) || !value.dependencies.every((id) => typeof id === 'string' && ID_PATTERN.test(id))) {
      throw new Error(`Invalid capability registry metadata: ${value.id}.dependencies`);
    }
    if (definitions.has(value.id)) throw new Error(`Duplicate capability registry ID: ${value.id}`);
    definitions.set(value.id, value as unknown as CapabilityDefinition);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Capability dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown capability dependency: ${id}`);
    visiting.add(id);
    for (const dependency of definition.dependencies) {
      if (dependency === id) throw new Error(`Self capability dependency: ${id}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of definitions.keys()) visit(id);
}
