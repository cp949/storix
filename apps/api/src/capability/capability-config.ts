import { readFile } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { validate as isUuid } from 'uuid';
import { CAPABILITY_ID_PATTERN } from './capability-registry.js';

export interface CapabilityConfig {
  /** 켤 수 있는 capability의 최종 상한이다. 어떤 모드에서도 넘지 못한다. */
  readonly globalAllowedCapabilities: readonly string[];

  /** namespace별 명시 허용 목록. 항목이 있으면 `defaultEnabledCapabilities`를 대신하고 빈 목록은 비활성이다. */
  readonly namespaceAllowedCapabilities: Readonly<Record<string, readonly string[]>>;

  /**
   * `namespaceAllowedCapabilities`에 항목이 없는 모든 namespace(설정 이후 만든 namespace 포함)에 적용하는
   * 기본 활성 목록이다. 키가 없으면 기본 활성이 없고 이전 동작과 같다.
   */
  readonly defaultEnabledCapabilities?: readonly string[];
}

const REQUIRED_KEYS = ['globalAllowedCapabilities', 'namespaceAllowedCapabilities'];
const OPTIONAL_KEYS = ['defaultEnabledCapabilities'];

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
  if (
    !isRecord(value) ||
    REQUIRED_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...REQUIRED_KEYS, ...OPTIONAL_KEYS].includes(key))
  ) {
    throw new Error(
      `Invalid capability configuration: expected ${REQUIRED_KEYS.join(' and ')} and optional ${OPTIONAL_KEYS.join(', ')}`,
    );
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
  if (Object.hasOwn(value, 'defaultEnabledCapabilities')) {
    return {
      globalAllowedCapabilities,
      namespaceAllowedCapabilities,
      defaultEnabledCapabilities: parseCapabilityList(
        value.defaultEnabledCapabilities,
        'defaultEnabledCapabilities',
      ),
    };
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
