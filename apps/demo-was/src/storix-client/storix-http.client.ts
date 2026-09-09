import { Inject, Injectable } from '@nestjs/common';
import type { DemoWasConfig } from '../config/demo-was-config.js';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import { StorixApiError, StorixUnreachableError } from './storix-client.errors.js';

interface StorixErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

export interface StorixRequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string | Uint8Array | null;
  readonly duplex?: 'half';
}

@Injectable()
export class StorixHttpClient {
  constructor(@Inject(DEMO_WAS_CONFIG) private readonly config: DemoWasConfig) {}

  async request(options: StorixRequestOptions): Promise<Response> {
    const url = new URL(options.path, this.config.storixBaseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${this.config.storixApiKey}`);

    let body: string | Uint8Array | null | undefined = options.body;
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.json);
    }

    let response: Response;
    try {
      // Node fetch(undici)는 스트리밍 요청 본문에 duplex 옵션을 요구한다.
      response = await fetch(url, { method: options.method, headers, body, duplex: options.duplex } as RequestInit);
    } catch (cause) {
      throw new StorixUnreachableError(cause);
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as StorixErrorBody | null;
      throw new StorixApiError(
        response.status,
        errorBody?.code ?? 'STORIX_UNKNOWN_ERROR',
        errorBody?.message ?? response.statusText,
        errorBody?.requestId,
      );
    }

    return response;
  }

  async requestJson<T>(options: StorixRequestOptions): Promise<T> {
    const response = await this.request(options);
    return (await response.json()) as T;
  }
}
