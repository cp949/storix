import type { Readable } from 'node:stream';

export interface BlobRange {
  readonly start: number;
  readonly end?: number;
}

export interface BlobObjectInfo {
  readonly key: string;
  readonly lastModified: Date;
}

export interface BlobPageOptions {
  /** 이 key 뒤(초과)부터 읽는다. 생략하면 prefix의 처음부터다. */
  readonly startAfter?: string;

  /** 한 번에 읽을 최대 object 수. 1 이상 1000 이하다. */
  readonly limit: number;
}

export interface BlobPage {
  /** key 오름차순 */
  readonly items: readonly BlobObjectInfo[];

  /** 이어 읽을 `startAfter`. null이면 prefix의 끝까지 읽었다. */
  readonly nextAfter: string | null;
}

export interface BlobStorage {
  put(key: string, stream: Readable, contentType?: string): Promise<void>;
  get(key: string, range?: BlobRange): Promise<Readable>;
  delete(key: string): Promise<void>;
  list(prefix?: string): AsyncIterable<BlobObjectInfo>;

  /**
   * prefix의 object를 key 오름차순으로 한 page만 읽는다. 전체를 메모리에 올리지 않고 `nextAfter`로
   * 이어 읽어야 하는 호출자(GC)가 쓴다. 구현체는 key가 UTF-8 바이트 순서로 정렬돼 반환되도록 보장해야 한다.
   */
  listPage(prefix: string, options: BlobPageOptions): Promise<BlobPage>;
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
