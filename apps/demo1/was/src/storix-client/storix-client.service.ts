import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DemoWasConfig } from '../config/demo-was-config.js';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import type {
  EntryPage,
  FileEntry,
  FileStat,
  PresignedDownload,
  PublicLink,
  UploadMetadata,
  UploadPartResult,
  UploadSessionCompletion,
  UploadSessionCreated,
  UploadSessionCreateRequest,
  UploadSessionStatus,
  UploadSessionCompleteResult,
} from './storix-client.types.js';
import { StorixApiError, StorixClientNotBootstrappedError } from './storix-client.errors.js';
import { StorixHttpClient } from './storix-http.client.js';
import { derivePublicPath } from './public-path.js';

interface NamespaceCreateResponse {
  readonly id: string;
}

interface NamespaceListPage {
  readonly items: ReadonlyArray<{ id: string; name: string | null; accessPolicy: 'PRIVATE' | 'PUBLIC' }>;
  readonly nextCursor: string | null;
}

// 이름이 이미 있다는 Storix의 도메인 오류 코드.
const NAMESPACE_ALREADY_EXISTS = 'NAMESPACE_ALREADY_EXISTS';

@Injectable()
export class StorixClient implements StorixClientPort {
  private demoNamespaceId: string | undefined;
  private publicNamespaceId: string | undefined;

  constructor(
    private readonly http: StorixHttpClient,
    @Inject(DEMO_WAS_CONFIG) private readonly config: DemoWasConfig,
  ) {}

  async ensureDemoNamespace(): Promise<string> {
    this.demoNamespaceId =
      this.config.namespaceId ??
      (await this.createNamespace(this.config.namespaceName, 'PRIVATE', 'demo-was:namespace:private'));
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
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/ls`,
      query: { path, cursor },
    });
  }

  async setMimeType(path: string, mimeType: string): Promise<FileEntry> {
    const namespaceId = this.requireDemoNamespaceId();
    const stat = await this.http.requestJson<FileStat>({
      method: 'GET',
      path: `/api/v2/namespaces/${namespaceId}/fs/stat`,
      query: { path },
    });
    const result = await this.http.requestJson<{ resource: FileEntry }>({
      method: 'POST',
      path: `/api/v2/namespaces/${namespaceId}/fs/mutations`,
      headers: {
        'idempotency-key': randomUUID(),
        'x-mutation-scope': 'demo1-was:set-mime-type',
      },
      json: { kind: 'setMimeType', path, ifRevision: stat.revision, mimeType },
    });
    return result.resource;
  }

  async createDirectory(path: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/mkdir`,
      json: { path, parents: true },
    });
  }

  async move(source: string, destination: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/mv`,
      json: { source, destination, destinationParents: true },
    });
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/cp`,
      json: { source, destination, destinationParents: true },
    });
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/rm`,
      query: { path, recursive: String(recursive) },
    });
  }

  async find(path: string, name: string, cursor?: string): Promise<EntryPage> {
    return this.http.requestJson<EntryPage>({
      method: 'GET',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/find`,
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
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/content`,
      query: { path, parents: 'true' },
      headers,
      body,
      duplex: 'half',
    });
  }

  async createUploadSession(
    request: UploadSessionCreateRequest,
    idempotencyKey: string | undefined,
    scope: string,
  ): Promise<UploadSessionCreated> {
    return this.http.requestJson<UploadSessionCreated>({
      method: 'POST',
      path: this.uploadSessionsPath(),
      headers: {
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        'x-mutation-scope': scope,
      },
      json: request,
    });
  }

  async getUploadSession(sessionId: string): Promise<UploadSessionStatus> {
    return this.http.requestJson<UploadSessionStatus>({
      method: 'GET',
      path: this.uploadSessionPath(sessionId),
    });
  }

  async putUploadSessionPart(
    sessionId: string,
    index: string,
    body: ReadableStream,
    contentLength: string | undefined,
    contentType: string | undefined,
  ): Promise<UploadPartResult> {
    return this.http.requestJson<UploadPartResult>({
      method: 'PUT',
      path: `${this.uploadSessionPath(sessionId)}/parts/${encodeURIComponent(index)}`,
      headers: {
        ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
      },
      body,
      duplex: 'half',
    });
  }

  async completeUploadSession(sessionId: string): Promise<UploadSessionCompletion> {
    const response = await this.http.request({
      method: 'POST',
      path: `${this.uploadSessionPath(sessionId)}/complete`,
    });
    return {
      status: response.status as 200 | 201,
      body: (await response.json()) as UploadSessionCompleteResult,
    };
  }

  async cancelUploadSession(sessionId: string): Promise<UploadSessionStatus> {
    return this.http.requestJson<UploadSessionStatus>({
      method: 'DELETE',
      path: this.uploadSessionPath(sessionId),
    });
  }

  private uploadSessionsPath(): string {
    return `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/upload-sessions`;
  }

  private uploadSessionPath(sessionId: string): string {
    return `${this.uploadSessionsPath()}/${encodeURIComponent(sessionId)}`;
  }

  async createDownload(path: string): Promise<PresignedDownload> {
    return this.http.requestJson<PresignedDownload>({
      method: 'GET',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/presigned-download`,
      query: { path },
    });
  }

  async publish(path: string): Promise<PublicLink> {
    const source = await this.http.request({
      method: 'GET',
      path: `/api/v2/namespaces/${this.requireDemoNamespaceId()}/fs/content`,
      query: { path },
    });

    const mimeType = source.headers.get('content-type') ?? undefined;
    const publicPath = derivePublicPath(path);

    await this.http.request({
      method: 'POST',
      path: `/api/v2/namespaces/${this.requirePublicNamespaceId()}/fs/content`,
      query: { path: publicPath, parents: 'true', force: 'true' },
      headers: mimeType ? { 'content-type': mimeType } : {},
      body: source.body as ReadableStream,
      duplex: 'half',
    });

    const url = new URL(
      `/api/v2/public/${this.requirePublicNamespaceId()}/fs/download`,
      this.config.publicUrlBase,
    );
    url.searchParams.set('path', publicPath);

    return { url: url.toString(), publicPath };
  }

  async unpublish(path: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: `/api/v2/namespaces/${this.requirePublicNamespaceId()}/fs/rm`,
      query: { path: derivePublicPath(path) },
    });
  }

  /**
   * namespace를 생성하고 id를 돌려준다. 고정 Idempotency-Key의 receipt는 Storix가 30일 뒤 지우므로,
   * 그 뒤 재기동하면 이름 충돌 409가 나온다. 이때는 이름과 accessPolicy가 같은 기존 namespace를 찾아 쓴다.
   */
  private async createNamespace(
    name: string,
    accessPolicy: 'PRIVATE' | 'PUBLIC',
    idempotencyKey: string,
  ): Promise<string> {
    try {
      const response = await this.http.requestJson<NamespaceCreateResponse>({
        method: 'POST',
        path: '/api/v2/namespaces',
        headers: { 'idempotency-key': idempotencyKey },
        json: { name, encryptionPolicy: 'NONE', accessPolicy },
      });
      return response.id;
    } catch (error) {
      if (
        !(error instanceof StorixApiError) ||
        error.status !== 409 ||
        error.code !== NAMESPACE_ALREADY_EXISTS
      ) {
        throw error;
      }
      const existingId = await this.findNamespaceId(name, accessPolicy);
      if (existingId === undefined) throw error;
      return existingId;
    }
  }

  /**
   * ACTIVE namespace 목록을 끝까지 순회해 이름과 accessPolicy가 모두 같은 항목의 id를 찾는다.
   * Storix에 이름 조회 API가 없어 전체를 훑는다. 데모가 namespace 수가 적은 인스턴스에 붙는다는 전제다.
   */
  private async findNamespaceId(
    name: string,
    accessPolicy: 'PRIVATE' | 'PUBLIC',
  ): Promise<string | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.http.requestJson<NamespaceListPage>({
        method: 'GET',
        path: '/api/v2/namespaces',
        query: { limit: '1000', cursor },
      });
      const found = page.items.find((item) => item.name === name && item.accessPolicy === accessPolicy);
      if (found) return found.id;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return undefined;
  }
}

export interface StorixClientPort {
  ensureDemoNamespace(): Promise<string>;
  ensurePublicNamespace(): Promise<string>;
  list(path: string, cursor?: string): Promise<EntryPage>;
  setMimeType(path: string, mimeType: string): Promise<FileEntry>;
  createDirectory(path: string): Promise<void>;
  upload(path: string, body: ReadableStream, metadata: UploadMetadata): Promise<FileEntry>;
  createUploadSession(
    request: UploadSessionCreateRequest,
    idempotencyKey: string | undefined,
    scope: string,
  ): Promise<UploadSessionCreated>;
  getUploadSession(sessionId: string): Promise<UploadSessionStatus>;
  putUploadSessionPart(
    sessionId: string,
    index: string,
    body: ReadableStream,
    contentLength: string | undefined,
    contentType: string | undefined,
  ): Promise<UploadPartResult>;
  completeUploadSession(sessionId: string): Promise<UploadSessionCompletion>;
  cancelUploadSession(sessionId: string): Promise<UploadSessionStatus>;
  move(source: string, destination: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  find(path: string, name: string, cursor?: string): Promise<EntryPage>;
  createDownload(path: string): Promise<PresignedDownload>;
  publish(path: string): Promise<PublicLink>;
  unpublish(path: string): Promise<void>;
}
