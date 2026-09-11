import { Body, Controller, Delete, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { parseDemoUser } from './demo-user.js';
import { firstQueryValue } from './http-query.js';
import { resolveInternalPath } from './path-guard.js';

@Controller('demo-api/entries')
export class EntriesController {
  constructor(private readonly storixClient: StorixClient) {}

  // move/copy/remove 전부 본문 없는 성공 응답이므로 204로 통일한다. Nest
  // 기본값(POST 201/DELETE 200)을 그대로 두면 프론트엔드 request()가 빈
  // 바디를 response.json()으로 파싱하려다 SyntaxError를 던진다.
  @Post('move')
  @HttpCode(204)
  async move(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Body() body: { source?: string; destination?: string },
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const source = resolveInternalPath(user, body?.source ?? '');
    const destination = resolveInternalPath(user, body?.destination ?? '');
    await this.storixClient.move(source, destination);
  }

  @Post('copy')
  @HttpCode(204)
  async copy(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Body() body: { source?: string; destination?: string },
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const source = resolveInternalPath(user, body?.source ?? '');
    const destination = resolveInternalPath(user, body?.destination ?? '');
    await this.storixClient.copy(source, destination);
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Query('recursive') recursive: string | string[] | undefined,
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    await this.storixClient.remove(internalPath, firstQueryValue(recursive) === 'true');
  }
}
