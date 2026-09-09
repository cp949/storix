import { Inject, Injectable } from '@nestjs/common';
import type { DemoWasConfig } from '../config/demo-was-config.js';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import type { EntryPage, FileEntry, PresignedDownload, PublicLink, UploadMetadata } from './storix-client.types.js';
import { StorixClientNotBootstrappedError } from './storix-client.errors.js';
import { StorixHttpClient } from './storix-http.client.js';

interface NamespaceCreateResponse {
  readonly id: string;
}

@Injectable()
export class StorixClient implements StorixClientPort {
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

  async upload(path: string, body: ReadableStream, metadata: UploadMetadata): Promise<FileEntry> {
    const headers: Record<string, string> = {};
    if (metadata.mimeType) {
      headers['content-type'] = metadata.mimeType;
    }
    if (metadata.contentLength !== undefined) {
      headers['content-length'] = String(metadata.contentLength);
    }

    return this.http.requestJson<FileEntry>({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/content`,
      query: { path, parents: 'true' },
      headers,
      body,
      duplex: 'half',
    });
  }

  async createDownload(path: string): Promise<PresignedDownload> {
    return this.http.requestJson<PresignedDownload>({
      method: 'GET',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/presigned-download`,
      query: { path },
    });
  }

  async publish(path: string): Promise<PublicLink> {
    const source = await this.http.request({
      method: 'GET',
      path: `/api/v1/namespaces/${this.requireDemoNamespaceId()}/fs/content`,
      query: { path },
    });

    const mimeType = source.headers.get('content-type') ?? undefined;

    await this.http.request({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requirePublicNamespaceId()}/fs/content`,
      query: { path, parents: 'true', force: 'true' },
      headers: mimeType ? { 'content-type': mimeType } : {},
      body: source.body as ReadableStream,
      duplex: 'half',
    });

    const url = new URL(`/api/v1/public/${this.requirePublicNamespaceId()}/fs/download`, this.config.publicUrlBase);
    url.searchParams.set('path', path);

    return { url: url.toString(), publicPath: path };
  }

  async unpublish(publicPath: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v1/namespaces/${this.requirePublicNamespaceId()}/fs/rm`,
      query: { path: publicPath },
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

export interface StorixClientPort {
  ensureDemoNamespace(): Promise<string>;
  ensurePublicNamespace(): Promise<string>;
  list(path: string, cursor?: string): Promise<EntryPage>;
  createDirectory(path: string): Promise<void>;
  upload(path: string, body: ReadableStream, metadata: UploadMetadata): Promise<FileEntry>;
  move(source: string, destination: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  find(path: string, name: string, cursor?: string): Promise<EntryPage>;
  createDownload(path: string): Promise<PresignedDownload>;
  publish(path: string): Promise<PublicLink>;
  unpublish(publicPath: string): Promise<void>;
}
