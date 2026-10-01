/**
 * 계약 정의 API와 계약이 받는 실행 컨텍스트 타입.
 * 계약 파일은 이 모듈의 `defineContract`만 import한다. `skip`·`only` 옵션은 제공하지 않는다.
 * 규칙은 docs/design/12-contract-checks.md "작성 규약".
 */

/** 서버 기동 설정 이름. 프로필마다 서버를 한 번 기동한다. */
export type ProfileName = 'default' | 'small-limits' | 'change-feed' | 'resumable-upload';

/** 계약이 호출한 HTTP 응답. */
export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;

  /** 본문 원본 바이트 */
  readonly bytes: Buffer;

  /** 본문을 UTF-8 문자열로 해석한다. */
  text(): string;

  /** 본문을 JSON으로 해석한다. */
  json<T = unknown>(): T;
}

/** 조건부 콘텐츠 저장의 전제 조건. 정확히 하나만 지정한다. */
export type ContentCondition = { readonly ifAbsent: true } | { readonly ifRevision: string };

/** 변경 요청(`Idempotency-Key`를 쓰는 POST)의 선택 인자. */
export interface MutationOptions {
  /** 멱등성 키. 생략하면 요청마다 새 키를 쓴다. 재전송을 검증하는 계약이 같은 값을 다시 준다. */
  readonly idempotencyKey?: string;
}

/** 서비스 API key로 인증하는 HTTP 클라이언트. */
export interface ApiClient {
  /** 임의의 요청을 보낸다. `path`는 `/`로 시작한다. */
  request(
    method: string,
    path: string,
    options?: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string | Buffer },
  ): Promise<ApiResponse>;

  /**
   * `POST /fs/content/conditional`로 파일 바이트를 조건부 저장한다. 요청마다 새 `Idempotency-Key`를 쓴다.
   * `contentType`을 생략하면 `application/octet-stream`이다. `expectedSha256`을 주면 `X-Content-Sha256`으로 보낸다.
   */
  putConditionalContent(
    namespaceId: string,
    filePath: string,
    bytes: Buffer,
    condition: ContentCondition,
    options?: MutationOptions & { readonly contentType?: string; readonly expectedSha256?: string },
  ): Promise<ApiResponse>;

  /** `POST /fs/mutations`로 조건부 변경(`delete`·`move` 등)을 보낸다. `body`는 JSON으로 직렬화한다. */
  postMutation(namespaceId: string, body: object, options?: MutationOptions): Promise<ApiResponse>;

  /** `POST /fs/snapshots`로 snapshot을 만든다. `body`는 `{ kind, path, sourceRevision? }`다. */
  createSnapshot(namespaceId: string, body: object, options?: MutationOptions): Promise<ApiResponse>;

  /** `GET /fs/snapshots/{id}`로 snapshot 메타데이터를 읽는다. */
  getSnapshot(namespaceId: string, snapshotId: string): Promise<ApiResponse>;

  /** `GET /fs/snapshots?rootNodeId=`로 파일 ID별 snapshot 목록을 페이지 단위로 읽는다. */
  listSnapshots(
    namespaceId: string,
    rootNodeId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<ApiResponse>;

  /** `GET /fs/snapshots/{id}/content`로 FILE snapshot의 전체 바이트를 읽는다. */
  getSnapshotContent(namespaceId: string, snapshotId: string): Promise<ApiResponse>;

  /** `POST /fs/snapshots/{id}/restore`로 snapshot을 `body.path`의 파일로 복원한다. */
  restoreSnapshot(
    namespaceId: string,
    snapshotId: string,
    body: object,
    options?: MutationOptions,
  ): Promise<ApiResponse>;

  /** `POST /fs/snapshots/{id}/delete`로 snapshot을 삭제한다. */
  deleteSnapshot(namespaceId: string, snapshotId: string, options?: MutationOptions): Promise<ApiResponse>;

  /** `GET /fs/changes`로 변경 feed를 읽는다. `cursor`를 생략하면 현재 sequence의 checkpoint를 받는다. */
  listChanges(
    namespaceId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<ApiResponse>;

  /** `GET /api/v2/namespaces/{id}/capabilities`로 활성 선택 capability ID 목록을 읽는다. */
  listCapabilities(namespaceId: string): Promise<ApiResponse>;

  /** `GET /fs/stat`으로 본문 없이 파일·디렉터리 메타데이터를 읽는다. */
  getStat(namespaceId: string, filePath: string): Promise<ApiResponse>;

  /** `POST /fs/mkdir`로 디렉터리를 만든다. `parents`가 true일 때만 없는 부모를 만든다. */
  mkdir(namespaceId: string, dirPath: string, parents?: boolean): Promise<ApiResponse>;

  /** `GET /fs/content`로 파일 바이트를 읽는다. `headers`에 `Range`를 주면 부분 응답을 받는다. */
  getContent(
    namespaceId: string,
    filePath: string,
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ): Promise<ApiResponse>;

  /** `GET /fs/ls`로 디렉터리의 직계 자식을 페이지 단위로 읽는다. `consistency: 'revision'`이면 디렉터리 revision에 묶인 cursor를 쓴다. */
  listDirectory(
    namespaceId: string,
    dirPath: string,
    options?: { readonly cursor?: string; readonly limit?: number; readonly consistency?: 'revision' },
  ): Promise<ApiResponse>;

  /** `POST /fs/mv`로 이동한다. `body`는 `{ source, destination, destinationParents? }`다. */
  move(namespaceId: string, body: object): Promise<ApiResponse>;

  /** `POST /fs/cp`로 복사한다. `body`는 `{ source, destination, destinationParents? }`다. */
  copy(namespaceId: string, body: object): Promise<ApiResponse>;

  /** `POST /fs/rm`으로 삭제한다. `recursive`가 true일 때만 비어 있지 않은 디렉터리를 지운다. */
  remove(namespaceId: string, targetPath: string, recursive?: boolean): Promise<ApiResponse>;

  /** `GET /api/v2/namespaces/{id}`로 namespace 조회 결과(한도·사용량 포함)를 읽는다. */
  getNamespace(namespaceId: string): Promise<ApiResponse>;

  /**
   * `PATCH /api/v2/admin/namespaces/{id}/quota`로 namespace 논리 사용량 상한을 바꾼다.
   * `adminKey`로 인증하고 `body`는 JSON으로 직렬화한다. `idempotencyKey`를 생략하면 새 키를 쓰고 `null`이면 헤더를 보내지 않는다.
   */
  updateNamespaceQuota(
    namespaceId: string,
    adminKey: string,
    body: object,
    options?: { readonly idempotencyKey?: string | null },
  ): Promise<ApiResponse>;

  /**
   * `PATCH /api/v2/admin/namespaces/{id}/trash`로 namespace 휴지통 정책을 바꾼다.
   * `adminKey`로 인증하고 `body`는 JSON으로 직렬화한다. `idempotencyKey`를 생략하면 새 키를 쓰고 `null`이면 헤더를 보내지 않는다.
   */
  updateNamespaceTrashPolicy(
    namespaceId: string,
    adminKey: string,
    body: object,
    options?: { readonly idempotencyKey?: string | null },
  ): Promise<ApiResponse>;

  /** 관리자 삭제 접수를 보낸다. key 생략은 새 키, null은 헤더 누락이다. 본문은 보내지 않는다. */
  deleteNamespace(
    namespaceId: string,
    adminKey: string,
    options?: { readonly idempotencyKey?: string | null },
  ): Promise<ApiResponse>;

  /** 관리자 key로 삭제 operation의 현재 상태를 조회한다. */
  getNamespaceDeletion(namespaceId: string, adminKey: string): Promise<ApiResponse>;

  /** `GET /fs/trash`로 미만료 휴지통 항목을 페이지 단위로 읽는다. */
  listTrash(
    namespaceId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<ApiResponse>;

  /** `POST /fs/trash/{id}/restore`로 휴지통 항목을 복구한다. `body`는 `{ targetPath? }`다. */
  restoreTrash(
    namespaceId: string,
    trashId: string,
    body: object,
    options?: MutationOptions,
  ): Promise<ApiResponse>;

  /** `POST /fs/trash/{id}/purge`로 휴지통 항목을 영구 삭제한다. 관리자 전용이라 `adminKey`로 인증한다. */
  purgeTrash(
    namespaceId: string,
    trashId: string,
    adminKey: string,
    options?: MutationOptions,
  ): Promise<ApiResponse>;

  /**
   * `POST /fs/upload-sessions`로 재개 업로드 세션을 만든다(`resumable-upload` capability 필요).
   * `body`는 `{ path, sizeBytes, mimeType, ifAbsent | ifRevision, sha256? }`다.
   */
  createUploadSession(namespaceId: string, body: object, options?: MutationOptions): Promise<ApiResponse>;

  /** `PUT /fs/upload-sessions/{id}/parts/{index}`로 조각 하나를 저장한다. */
  putUploadPart(namespaceId: string, sessionId: string, index: number, bytes: Buffer): Promise<ApiResponse>;

  /** `GET /fs/upload-sessions/{id}`로 세션 상태를 읽는다. */
  getUploadSession(namespaceId: string, sessionId: string): Promise<ApiResponse>;

  /** `DELETE /fs/upload-sessions/{id}`로 열린 세션을 취소한다. */
  cancelUploadSession(namespaceId: string, sessionId: string): Promise<ApiResponse>;

  /** `POST /fs/upload-sessions/{id}/complete`로 저장된 조각을 파일로 공개한다. 본문은 없다. */
  completeUploadSession(namespaceId: string, sessionId: string): Promise<ApiResponse>;
}

/** 계약 전용으로 만든 namespace. */
export interface NamespaceInfo {
  readonly id: string;
  readonly name: string;
}

/** 계약이 제어할 수 있는 서버. */
export interface ContractServer {
  /** 같은 포트·env·DB로 서버를 종료 후 다시 기동한다. 재시작 뒤 지속성·재생을 검증하는 계약이 쓴다. */
  restart(): Promise<void>;
}

/**
 * 계약이 제어할 수 있는 blob 저장소. 저장 장애를 만드는 계약만 쓴다.
 * 계약이 저장소를 멈춘 채 끝나거나 실패해도 러너가 다음 계약 전에 되살린다.
 */
export interface ContractBlobStorage {
  /** 저장소를 멈춘다. 멈춘 동안 저장소를 쓰는 요청은 일시 장애로 실패한다. */
  stop(): Promise<void>;

  /** 멈춘 저장소를 같은 주소·같은 데이터로 다시 시작하고 준비될 때까지 기다린다. */
  start(): Promise<void>;

  /** 저장소의 객체를 모두 지운다. 이미 저장한 파일의 바이트가 사라진 상태를 만든다. 다른 계약의 파일도 지우므로 뒤 계약은 앞 계약의 파일에 기대지 않는다. */
  deleteAllObjects(): Promise<void>;
}

/** 계약의 `run`이 받는 컨텍스트. */
export interface ContractContext {
  /** 실행 취소 신호다. 직접 HTTP 요청과 계약 내부 대기에도 전달한다. */
  readonly signal: AbortSignal;

  /** 서버 기본 URL. 끝에 `/`가 없다. */
  readonly baseUrl: string;

  /** 서비스 API key. `client`가 쓰는 값이며, 클라이언트로 표현할 수 없는 저수준 요청(중단된 업로드 등)에 쓴다. */
  readonly apiKey: string;

  /** 관리자 API key(`STORIX_ADMIN_API_KEY`). `/api/v2/admin/**`를 `Authorization: Bearer`로 호출할 때 쓴다. 서비스 key로는 인증되지 않는다. */
  readonly adminKey: string;

  readonly client: ApiClient;

  readonly server: ContractServer;

  readonly blobStorage: ContractBlobStorage;

  /**
   * 이 계약만 쓰는 namespace를 받는다. 정리 코드는 필요 없다(서버 종료가 정리한다).
   * capability를 허용하는 프로필에서는 그 capability가 켜진 namespace다.
   * `withoutCapabilities`를 주면 허용 목록에 없는 새 namespace를 API로 만든다(선택 capability가 꺼진 상태).
   * `accessPolicy`를 주면(`'PRIVATE'` 포함) 사전 준비 풀을 쓰지 않고 새 namespace를 API로 만든다. 사전 준비 namespace는 모두 `PRIVATE`이므로
   * `'PUBLIC'`이면 무인증 공개 조회가 열린다. 이 namespace는 `withoutCapabilities`와 같이 선택 capability가 꺼진 상태다.
   */
  createNamespace(options?: CreateNamespaceOptions): Promise<NamespaceInfo>;
}

/** `ContractContext.createNamespace`의 옵션. */
export interface CreateNamespaceOptions {
  readonly withoutCapabilities?: boolean;
  readonly accessPolicy?: 'PRIVATE' | 'PUBLIC';
}

/** `defineContract`에 넘기는 입력. */
export interface ContractDefinition {
  /** 소문자 kebab-case 식별자. 전체 계약에서 유일하다. */
  readonly id: string;

  /** 소비자가 기대하는 동작을 한 문장으로 쓴 한글 제목 */
  readonly title: string;

  /** 대응하는 요구사항 ID 목록. `docs/requirements/file-storage.md`에 있어야 한다. */
  readonly rq: readonly string[];

  /** 서버 기동 설정. 생략하면 `default`다. */
  readonly profile?: ProfileName;

  /** 검증 본문. `node:assert/strict`로 검증하고 위반 시 throw한다. */
  run(ctx: ContractContext): Promise<void>;
}

/** 검증을 마친 계약. */
export interface Contract {
  readonly kind: 'contract';
  readonly id: string;
  readonly title: string;
  readonly rq: readonly string[];
  readonly profile: ProfileName;
  run(ctx: ContractContext): Promise<void>;
}

const ALLOWED_KEYS = new Set(['id', 'title', 'rq', 'profile', 'run']);
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RQ_PATTERN = /^RQ-\d{3}$/;

/** 입력을 검증해 계약을 만든다. 형식 위반은 즉시 throw한다. */
export function defineContract(definition: ContractDefinition): Contract {
  for (const key of Object.keys(definition)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`알 수 없는 계약 옵션: ${key}. skip·only는 제공하지 않는다.`);
    }
  }
  if (!ID_PATTERN.test(definition.id)) {
    throw new Error(`계약 id는 소문자 kebab-case여야 한다: ${definition.id}`);
  }
  if (definition.title.trim().length === 0) {
    throw new Error(`계약 ${definition.id}: title이 비어 있다.`);
  }
  if (definition.rq.length === 0) {
    throw new Error(`계약 ${definition.id}: rq가 비어 있다.`);
  }
  for (const rq of definition.rq) {
    if (!RQ_PATTERN.test(rq)) {
      throw new Error(`계약 ${definition.id}: RQ ID 형식이 잘못됐다: ${rq}`);
    }
  }
  return {
    kind: 'contract',
    id: definition.id,
    title: definition.title,
    rq: definition.rq,
    profile: definition.profile ?? 'default',
    run: definition.run,
  };
}
