import { parseOptionalString, parsePositiveInt, requireEnv } from '../common/env-parsing.js';

const NAMESPACE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z][a-z0-9_-]{0,11}_)?[0-9a-f]{32})$/;

export interface DemoWasConfig {
  readonly port: number;
  readonly storixBaseUrl: string;
  readonly storixApiKey: string;
  readonly namespaceName: string;
  readonly namespaceId: string | undefined;
  readonly publicNamespaceName: string;
  readonly publicUrlBase: string;
}

export const DEMO_WAS_CONFIG = Symbol('DEMO_WAS_CONFIG');

function parseNamespaceId(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!NAMESPACE_ID.test(value)) {
    throw new Error('잘못된 Namespace ID 환경변수 값: DEMO_WAS_NAMESPACE_ID');
  }
  return value;
}

export function loadDemoWasConfig(): DemoWasConfig {
  const storixBaseUrl = requireEnv('DEMO_WAS_STORIX_BASE_URL');

  return {
    port: parsePositiveInt(process.env.DEMO_WAS_PORT, 4000),
    storixBaseUrl,
    storixApiKey: requireEnv('DEMO_WAS_STORIX_API_KEY'),
    namespaceName: parseOptionalString(process.env.DEMO_WAS_NAMESPACE_NAME) ?? 'demo',
    namespaceId: parseNamespaceId(process.env.DEMO_WAS_NAMESPACE_ID),
    publicNamespaceName: parseOptionalString(process.env.DEMO_WAS_PUBLIC_NAMESPACE_NAME) ?? 'demo-public',
    publicUrlBase: parseOptionalString(process.env.DEMO_WAS_PUBLIC_URL_BASE) ?? storixBaseUrl,
  };
}
