/** `buildServerEnv` 입력. */
export interface ServerEnvInput {
  readonly port: number;
  readonly apiKey: string;
  readonly adminKey: string;

  /** 프로필이 덧씌우는 env. 가장 나중에 적용한다. */
  readonly profileEnv: Readonly<Record<string, string>>;

  readonly databaseEnv: Readonly<Record<string, string>>;
  readonly storageEnv: Readonly<Record<string, string>>;
}

/**
 * API 서버 프로세스에 전달할 env를 명시적으로 만든다.
 * 부모 프로세스의 `STORIX_*`가 서버 설정에 섞이지 않도록 `PATH`만 상속한다.
 */
export function buildServerEnv(input: ServerEnvInput): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    STORIX_PORT: String(input.port),
    STORIX_API_KEY: input.apiKey,
    STORIX_ADMIN_API_KEY: input.adminKey,
    ...input.storageEnv,
    ...input.databaseEnv,
    ...input.profileEnv,
  };
}
