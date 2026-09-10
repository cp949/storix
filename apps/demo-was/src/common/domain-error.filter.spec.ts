import { Controller, Get, INestApplication, NotFoundException, UseFilters } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DomainError } from './domain-error.js';
import { DomainErrorFilter } from './domain-error.filter.js';

class TeapotError extends DomainError {
  readonly code = 'TEAPOT';
  readonly status = 418;
  constructor() {
    super('나는 찻주전자다');
  }
}

@Controller('probe')
@UseFilters(DomainErrorFilter)
class ProbeController {
  @Get('domain-error')
  throwDomainError(): never {
    throw new TeapotError();
  }

  @Get('unknown-error')
  throwUnknownError(): never {
    throw new Error('예상 못한 오류');
  }

  @Get('http-error')
  throwHttpError(): never {
    throw new NotFoundException('없음');
  }
}

describe('DomainErrorFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = 'test-request-id';
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('DomainError는 code/status/requestId를 그대로 노출한다', async () => {
    const response = await request(app.getHttpServer()).get('/probe/domain-error').expect(418);
    expect(response.body).toEqual({
      code: 'TEAPOT',
      message: '나는 찻주전자다',
      requestId: 'test-request-id',
    });
  });

  it('DomainError가 아닌 예외는 500과 INTERNAL_ERROR로 은닉한다', async () => {
    const response = await request(app.getHttpServer()).get('/probe/unknown-error').expect(500);
    expect(response.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'test-request-id',
    });
  });

  it('HttpException은 자기 상태 코드를 그대로 유지한다(500으로 뭉개지지 않는다)', async () => {
    const response = await request(app.getHttpServer()).get('/probe/http-error').expect(404);
    expect(response.body).toEqual({
      code: 'HTTP_ERROR',
      message: '없음',
      requestId: 'test-request-id',
    });
  });
});
