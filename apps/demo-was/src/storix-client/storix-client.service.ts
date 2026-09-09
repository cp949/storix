import { Inject, Injectable } from '@nestjs/common';
import type { DemoWasConfig } from '../config/demo-was-config.js';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import { StorixClientNotBootstrappedError } from './storix-client.errors.js';
import { StorixHttpClient } from './storix-http.client.js';

interface NamespaceCreateResponse {
  readonly id: string;
}

@Injectable()
export class StorixClient {
  private demoNamespaceId: string | undefined;
  private publicNamespaceId: string | undefined;

  constructor(
    private readonly http: StorixHttpClient,
    @Inject(DEMO_WAS_CONFIG) private readonly config: DemoWasConfig,
  ) {}

  async ensureDemoNamespace(): Promise<string> {
    this.demoNamespaceId = await this.createNamespace(this.config.namespaceName, 'PRIVATE', 'demo-was:namespace:private');
    return this.demoNamespaceId;
  }

  async ensurePublicNamespace(): Promise<string> {
    this.publicNamespaceId = await this.createNamespace(
      this.config.publicNamespaceName,
      'PUBLIC',
      'demo-was:namespace:public',
    );
    return this.publicNamespaceId;
  }

  protected requireDemoNamespaceId(): string {
    if (!this.demoNamespaceId) {
      throw new StorixClientNotBootstrappedError();
    }
    return this.demoNamespaceId;
  }

  protected requirePublicNamespaceId(): string {
    if (!this.publicNamespaceId) {
      throw new StorixClientNotBootstrappedError();
    }
    return this.publicNamespaceId;
  }

  private async createNamespace(
    name: string,
    accessPolicy: 'PRIVATE' | 'PUBLIC',
    idempotencyKey: string,
  ): Promise<string> {
    const response = await this.http.requestJson<NamespaceCreateResponse>({
      method: 'POST',
      path: '/api/v1/namespaces',
      headers: { 'idempotency-key': idempotencyKey },
      json: { name, encryptionPolicy: 'NONE', accessPolicy },
    });
    return response.id;
  }
}
