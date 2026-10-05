import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule, resolveValidApiKeys } from '../../src/auth/auth.module.js';
import { VALID_API_KEYS } from '../../src/auth/auth.constants.js';

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
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule],
    })
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

  // 관리자 키가 서비스 키와 같으면 서비스 키로 /api/v2/admin/**를 호출할 수 있게 되므로 부팅 단계에서 막는다.
  describe('관리자 키와 서비스 키 분리', () => {
    it.each([
      ['STORIX_ADMIN_API_KEY', 'STORIX_API_KEY'],
      ['STORIX_ADMIN_API_KEY', 'STORIX_API_KEY_PREVIOUS'],
      ['STORIX_ADMIN_API_KEY_PREVIOUS', 'STORIX_API_KEY'],
      ['STORIX_ADMIN_API_KEY_PREVIOUS', 'STORIX_API_KEY_PREVIOUS'],
    ])('%s가 %s와 같은 값이면 모듈 컴파일이 실패한다', async (adminName, serviceName) => {
      const values: Record<string, string> = {
        STORIX_API_KEY: 'service-current',
        STORIX_API_KEY_PREVIOUS: 'service-previous',
        STORIX_ADMIN_API_KEY: 'admin-current',
        STORIX_ADMIN_API_KEY_PREVIOUS: 'admin-previous',
      };
      values[adminName] = values[serviceName];

      await expect(compileWith(values)).rejects.toThrow(`${adminName}는 ${serviceName}와 같은 값일 수 없다`);
    });

    it('충돌 오류 메시지에 키 값을 담지 않는다', async () => {
      const error = await compileWith({
        STORIX_API_KEY: 'shared-secret-value',
        STORIX_ADMIN_API_KEY: 'shared-secret-value',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('shared-secret-value');
    });

    it('관리자 키가 서비스 키와 모두 다르면 모듈을 정상 조립한다', async () => {
      const moduleRef = await compileWith({
        STORIX_API_KEY: 'service-current',
        STORIX_API_KEY_PREVIOUS: 'service-previous',
        STORIX_ADMIN_API_KEY: 'admin-current',
        STORIX_ADMIN_API_KEY_PREVIOUS: 'admin-previous',
      });

      expect(moduleRef.get(VALID_API_KEYS)).toEqual(['service-current', 'service-previous']);
    });

    it('관리자 키가 비어 있으면 이전 관리자 키가 서비스 키와 같아도 모듈을 정상 조립한다', async () => {
      // 관리자 현재 키가 비면 관리자 API 전체가 닫히므로 이전 관리자 키는 인증에 쓰이지 않는다.
      const moduleRef = await compileWith({
        STORIX_API_KEY: 'service-current',
        STORIX_ADMIN_API_KEY: '',
        STORIX_ADMIN_API_KEY_PREVIOUS: 'service-current',
      });

      expect(moduleRef.get(VALID_API_KEYS)).toEqual(['service-current']);
    });
  });
});

function compileWith(values: Record<string, string>) {
  return Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule] })
    .overrideProvider(ConfigService)
    .useValue({
      getOrThrow: (key: string) => {
        const value = values[key];
        if (value === undefined) throw new Error(`${key} 없음`);
        return value;
      },
      get: (key: string) => values[key],
    })
    .compile();
}
