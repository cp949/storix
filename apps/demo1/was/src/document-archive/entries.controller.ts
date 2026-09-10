import { Body, Controller, Delete, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { parseDemoUser } from './demo-user.js';
import { firstQueryValue } from './http-query.js';
import { resolveInternalPath } from './path-guard.js';

@Controller('demo-api/entries')
export class EntriesController {
  constructor(private readonly storixClient: StorixClient) {}

  // POST의 Nest 기본 성공 상태 코드가 이미 201이므로 move/copy에는 별도
  // @HttpCode가 필요 없다(documents.controller.ts의 publish()와 동일한 관례).
  // DELETE는 기본이 200이라 remove()에는 @HttpCode(204)가 필요하다.
  @Post('move')
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
