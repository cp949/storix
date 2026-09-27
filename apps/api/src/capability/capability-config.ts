import { readFile } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { validate as isUuid } from 'uuid';
import { CAPABILITY_ID_PATTERN } from './capability-registry.js';

export interface CapabilityConfig {
  readonly globalAllowedCapabilities: readonly string[];
  readonly namespaceAllowedCapabilities: Readonly<Record<string, readonly string[]>>;
}

const CONFIG_KEYS = ['globalAllowedCapabilities', 'namespaceAllowedCapabilities'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCapabilityList(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === 'string' && CAPABILITY_ID_PATTERN.test(id))
  ) {
    throw new Error(
      `Invalid capability configuration: ${field} must be a list of lowercase kebab-case identifiers`,
    );
  }
  return value;
}

function parseCapabilityConfig(value: unknown): CapabilityConfig {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== CONFIG_KEYS.slice().sort().join(',')) {
    throw new Error(`Invalid capability configuration: expected only ${CONFIG_KEYS.join(' and ')}`);
  }
  const globalAllowedCapabilities = parseCapabilityList(
    value.globalAllowedCapabilities,
    'globalAllowedCapabilities',
  );
  if (!isRecord(value.namespaceAllowedCapabilities)) {
    throw new Error('Invalid capability configuration: namespaceAllowedCapabilities must be an object');
  }
  const namespaceAllowedCapabilities: Record<string, readonly string[]> = {};
  for (const [namespaceId, capabilities] of Object.entries(value.namespaceAllowedCapabilities)) {
    if (!isUuid(namespaceId)) {
      throw new Error(`Invalid capability configuration: namespace ID ${namespaceId} is not a UUID`);
    }
    const normalizedId = namespaceId.toLowerCase();
    if (Object.hasOwn(namespaceAllowedCapabilities, normalizedId)) {
      throw new Error(`Invalid capability configuration: duplicate namespace ID ${normalizedId}`);
    }
    namespaceAllowedCapabilities[normalizedId] = parseCapabilityList(
      capabilities,
      `namespaceAllowedCapabilities.${namespaceId}`,
    );
  }
  return { globalAllowedCapabilities, namespaceAllowedCapabilities };
}

export async function loadCapabilityConfig(config: ConfigService): Promise<CapabilityConfig> {
  const path = config.get<string>('STORIX_VFS_CAPABILITIES_CONFIG_PATH');
  if (path === undefined || path === '') {
    return { globalAllowedCapabilities: [], namespaceAllowedCapabilities: {} };
  }

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read capability configuration at ${path}`, { cause });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new Error(`Invalid capability configuration JSON at ${path}`, { cause });
  }
  return parseCapabilityConfig(value);
}
