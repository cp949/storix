import { Inject, Injectable } from '@nestjs/common';
import type { DemoWasConfig } from '../config/demo-was-config.js';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import type { EntryPage } from './storix-client.types.js';
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

  async list(path: string, cursor?: string): Promise<EntryPage> {
    return this.http.requestJson<EntryPage>({
      method: 'GET',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/ls`,
      query: { path, cursor },
    });
  }

  async createDirectory(path: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/mkdir`,
      json: { path, parents: true },
    });
  }

  async move(source: string, destination: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/mv`,
      json: { source, destination, destinationParents: true },
    });
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/cp`,
      json: { source, destination, destinationParents: true },
    });
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/rm`,
      query: { path, recursive: String(recursive) },
    });
  }

  async find(path: string, name: string, cursor?: string): Promise<EntryPage> {
    return this.http.requestJson<EntryPage>({
      method: 'GET',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/find`,
      query: { path, name, cursor },
    });
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
