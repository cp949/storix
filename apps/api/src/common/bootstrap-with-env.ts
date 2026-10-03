import { resolveSecrets } from '../secrets/resolve-secrets.js';

export function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

// entities의 드라이버 중립 컬럼 타입 상수(dialect-column-types.ts)가 모듈 로드
// 시점에 process.env.STORIX_DB_DRIVER를 읽어 얼어붙는다. loadModule()이 감싸는
// import()는 loadEnvFile() 이후에만 평가돼야 하므로, 호출부는 대상 루트
// 모듈(AppModule 등)을 정적 import하지 말고 이 함수를 통해서만 불러와야 한다.
// 비밀값(`X_FILE`·`X_REF`)은 .env 로드 뒤, 루트 모듈 import 전에 해석한다. 소비자는 process.env와 ConfigService로 읽는다.
export async function bootstrapWithEnv<T>(
  loadModule: () => Promise<T>,
  resolve: () => Promise<void> = resolveSecrets,
): Promise<T> {
  loadEnvFile();
  await resolve();
  return loadModule();
}
