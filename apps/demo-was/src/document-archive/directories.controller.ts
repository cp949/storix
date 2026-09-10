import { Body, Controller, Headers, Post } from '@nestjs/common';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { parseDemoUser } from './demo-user.js';
import { resolveInternalPath } from './path-guard.js';

@Controller('demo-api/directories')
export class DirectoriesController {
  constructor(private readonly storixClient: StorixClient) {}

  // POST의 Nest 기본 성공 상태 코드가 이미 201이므로 별도 @HttpCode가 필요 없다
  // (documents.controller.ts의 publish()와 동일한 관례).
  @Post()
  async create(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Body() body: { path?: string },
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, body?.path ?? '');
    await this.storixClient.createDirectory(internalPath);
  }
}
