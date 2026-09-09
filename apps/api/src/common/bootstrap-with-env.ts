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
export async function bootstrapWithEnv<T>(loadModule: () => Promise<T>): Promise<T> {
  loadEnvFile();
  return loadModule();
}
