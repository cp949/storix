import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule, resolveValidApiKeys } from './auth.module.js';
import { VALID_API_KEYS } from './auth.constants.js';

describe('resolveValidApiKeys', () => {
  it('이전 키가 없으면 현재 키만 담은 배열을 반환한다', () => {
    expect(resolveValidApiKeys('current-key', undefined)).toEqual(['current-key']);
  });

  it('이전 키가 있으면 현재 키와 이전 키를 모두 담은 배열을 반환한다', () => {
    expect(resolveValidApiKeys('current-key', 'previous-key')).toEqual(['current-key', 'previous-key']);
  });

  it('이전 키가 빈 문자열이면 현재 키만 담은 배열을 반환한다', () => {
    expect(resolveValidApiKeys('current-key', '')).toEqual(['current-key']);
  });

  it('현재 키가 빈 문자열이면 에러를 던진다', () => {
    expect(() => resolveValidApiKeys('', undefined)).toThrow('STORIX_API_KEY는 비어 있을 수 없다');
  });

  it('현재 키가 공백만 있으면 에러를 던진다', () => {
    expect(() => resolveValidApiKeys('   ', undefined)).toThrow('STORIX_API_KEY는 비어 있을 수 없다');
  });
});

describe('AuthModule', () => {
  it('STORIX_API_KEY가 유효하면 VALID_API_KEYS를 정상적으로 조립한다', async () => {
    // AuthModule은 ConfigModule을 직접 import하지 않고 AppModule의 전역 등록에 의존하므로,
    // 여기서 ConfigModule을 함께 import해야 overrideProvider(ConfigService)가 적용될 대상을 찾는다.
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule] })
      .overrideProvider(ConfigService)
      .useValue({
        getOrThrow: (key: string) => (key === 'STORIX_API_KEY' ? 'a'.repeat(64) : undefined),
        get: () => undefined,
      })
      .compile();

    expect(moduleRef.get(VALID_API_KEYS)).toEqual(['a'.repeat(64)]);
  });

  it('STORIX_API_KEY가 빈 문자열이면 모듈 컴파일이 실패한다', async () => {
    await expect(
      Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule] })
        .overrideProvider(ConfigService)
        .useValue({ getOrThrow: () => '', get: () => undefined })
        .compile(),
    ).rejects.toThrow('STORIX_API_KEY는 비어 있을 수 없다');
  });
});
