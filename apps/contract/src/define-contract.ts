/**
 * 계약 정의 API와 계약이 받는 실행 컨텍스트 타입.
 * 계약 파일은 이 모듈의 `defineContract`만 import한다. `skip`·`only` 옵션은 제공하지 않는다.
 * 규칙은 docs/design/12-contract-checks.md "작성 규약".
 */

/** 서버 기동 설정 이름. 프로필마다 서버를 한 번 기동한다. */
export type ProfileName = 'default';

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

/** 서비스 API key로 인증하는 HTTP 클라이언트. */
export interface ApiClient {
  /** 임의의 요청을 보낸다. `path`는 `/`로 시작한다. */
  request(
    method: string,
    path: string,
    options?: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string | Buffer },
  ): Promise<ApiResponse>;

  /** `POST /fs/content/conditional`로 파일 바이트를 조건부 저장한다. 요청마다 새 `Idempotency-Key`를 쓴다. */
  putConditionalContent(
    namespaceId: string,
    filePath: string,
    bytes: Buffer,
    condition: ContentCondition,
  ): Promise<ApiResponse>;

  /** `GET /fs/content`로 전체 파일 바이트를 읽는다. */
  getContent(namespaceId: string, filePath: string): Promise<ApiResponse>;
}

/** 계약 전용으로 만든 namespace. */
export interface NamespaceInfo {
  readonly id: string;
  readonly name: string;
}

/** 계약의 `run`이 받는 컨텍스트. */
export interface ContractContext {
  /** 서버 기본 URL. 끝에 `/`가 없다. */
  readonly baseUrl: string;

  readonly client: ApiClient;

  /** 이 계약만 쓰는 namespace를 새로 만든다. 정리 코드는 필요 없다(서버 종료가 정리한다). */
  createNamespace(): Promise<NamespaceInfo>;
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
