import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { parseDemoUser } from './demo-user.js';
import { resolveInternalPath } from './path-guard.js';

@Controller('demo-api/directories')
export class DirectoriesController {
  constructor(private readonly storixClient: StorixClient) {}

  // 본문 없는 성공 응답이므로 204로 맞춘다. Nest 기본값(POST 201)을 그대로 두면
  // 프론트엔드 request()가 빈 바디를 response.json()으로 파싱하려다 SyntaxError를
  // 던진다(publish()의 201은 실제 JSON 바디를 반환하므로 문제없는 것과 다르다).
  @Post()
  @HttpCode(204)
  async create(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Body() body: { path?: string },
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, body?.path ?? '');
    await this.storixClient.createDirectory(internalPath);
  }
}
