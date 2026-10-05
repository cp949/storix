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

/** 완료·취소되지 않고 남은 multipart upload 하나. */
export interface IncompleteUploadInfo {
  readonly key: string;
  readonly uploadId: string;

  /** upload를 시작한 시각이다. */
  readonly initiated: Date;
}

export interface IncompleteUploadPageOptions {
  /** 이 key 뒤(초과)부터 읽는다. 생략하면 prefix의 처음부터다. */
  readonly after?: string;

  /** 한 번에 읽을 최대 upload 수. 1 이상 1000 이하다. */
  readonly limit: number;
}

export interface IncompleteUploadPage {
  /** key 오름차순 */
  readonly items: readonly IncompleteUploadInfo[];

  /** 이어 읽을 `after`. null이면 prefix의 끝까지 읽었다. */
  readonly next: string | null;
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
   * prefix 아래에서 완료·취소되지 않은 multipart upload를 한 page만 읽는다. 프로세스가 강제 종료되면
   * `put`의 정리가 실행되지 않아 조각이 남는다. 완성 object가 아니므로 `list`·`listPage`에는 보이지 않는다.
   * 이어 읽는 위치는 key뿐이다. VersityGW가 `UploadIdMarker`를 거부해서(`InvalidArgument`) 쓰지 않는다.
   * 같은 key의 미완료 upload가 둘 이상이고 page 경계에 걸리면 나머지는 이번 순회에서 건너뛴다.
   */
  listIncompleteUploadsPage(
    prefix: string,
    options: IncompleteUploadPageOptions,
  ): Promise<IncompleteUploadPage>;

  /** 미완료 multipart upload와 올라간 조각을 지운다. 이미 없는 upload는 성공으로 본다. */
  abortIncompleteUpload(key: string, uploadId: string): Promise<void>;
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
