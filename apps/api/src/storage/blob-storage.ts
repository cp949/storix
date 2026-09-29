import type { Readable } from 'node:stream';

export interface BlobRange {
  readonly start: number;
  readonly end?: number;
}

export interface BlobObjectInfo {
  readonly key: string;
  readonly lastModified: Date;
}

export interface BlobStorage {
  put(key: string, stream: Readable, contentType?: string): Promise<void>;
  get(key: string, range?: BlobRange): Promise<Readable>;
  delete(key: string): Promise<void>;
  list(prefix?: string): AsyncIterable<BlobObjectInfo>;
  /**
   * 객체를 직접 받을 수 있는 서명 URL을 발급한다.
   * `contentDisposition`·`contentType`은 응답 헤더 재정의로 서명에 포함된다. `contentType`이 없으면 객체에 저장된 값이 응답된다.
   */
  getPresignedUrl(
    key: string,
    expirySeconds: number,
    contentDisposition?: string,
    contentType?: string,
  ): Promise<string>;
}
