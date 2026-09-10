import { parseOptionalString, parsePositiveInt, requireEnv } from '../common/env-parsing.js';

export interface DemoWasConfig {
  readonly port: number;
  readonly storixBaseUrl: string;
  readonly storixApiKey: string;
  readonly namespaceName: string;
  readonly publicNamespaceName: string;
  readonly publicUrlBase: string;
}

export const DEMO_WAS_CONFIG = Symbol('DEMO_WAS_CONFIG');

export function loadDemoWasConfig(): DemoWasConfig {
  const storixBaseUrl = requireEnv('DEMO_WAS_STORIX_BASE_URL');

  return {
    port: parsePositiveInt(process.env.DEMO_WAS_PORT, 4000),
    storixBaseUrl,
    storixApiKey: requireEnv('DEMO_WAS_STORIX_API_KEY'),
    namespaceName: parseOptionalString(process.env.DEMO_WAS_NAMESPACE_NAME) ?? 'demo',
    publicNamespaceName: parseOptionalString(process.env.DEMO_WAS_PUBLIC_NAMESPACE_NAME) ?? 'demo-public',
    publicUrlBase: parseOptionalString(process.env.DEMO_WAS_PUBLIC_URL_BASE) ?? storixBaseUrl,
  };
}
