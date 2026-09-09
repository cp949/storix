import { Body, Controller, Delete, Headers, HttpCode, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { parseDemoUser } from './demo-user.js';
import { resolveInternalPath } from './path-guard.js';

@Controller('demo-api/documents')
export class DocumentsController {
  constructor(private readonly storixClient: StorixClient) {}

  @Put('content')
  async putContent(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, path ?? '');

    const entry = await this.storixClient.upload(internalPath, Readable.toWeb(req) as ReadableStream, {
      mimeType: contentType,
      contentLength: contentLength !== undefined ? Number(contentLength) : undefined,
    });

    res.status(201);
    return entry;
  }

  @Post('download')
  async createDownload(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Body() body: { path?: string },
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, body.path ?? '');
    return this.storixClient.createDownload(internalPath);
  }

  @Post('publish')
  async publish(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, path ?? '');
    return this.storixClient.publish(internalPath);
  }

  @Delete('publish')
  @HttpCode(204)
  async unpublish(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | undefined,
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, path ?? '');
    await this.storixClient.unpublish(internalPath);
  }
}
