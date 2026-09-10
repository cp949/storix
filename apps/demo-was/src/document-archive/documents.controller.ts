import { Body, Controller, Delete, Get, Headers, HttpCode, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { DemoUser } from './demo-user.js';
import type { FileEntry } from '../storix-client/storix-client.types.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { parseDemoUser } from './demo-user.js';
import { firstQueryValue } from './http-query.js';
import { resolveExternalPath, resolveInternalPath } from './path-guard.js';

function toExternalEntry(user: DemoUser, entry: FileEntry): FileEntry {
  return { ...entry, path: resolveExternalPath(user, entry.path) };
}

@Controller('demo-api/documents')
export class DocumentsController {
  constructor(private readonly storixClient: StorixClient) {}

  @Get()
  async list(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Query('cursor') cursor: string | string[] | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    const page = await this.storixClient.list(internalPath, firstQueryValue(cursor));
    return { items: page.items.map((entry) => toExternalEntry(user, entry)), nextCursor: page.nextCursor };
  }

  @Get('search')
  async search(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Query('name') name: string | string[] | undefined,
    @Query('cursor') cursor: string | string[] | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    const page = await this.storixClient.find(internalPath, firstQueryValue(name) ?? '', firstQueryValue(cursor));
    return { items: page.items.map((entry) => toExternalEntry(user, entry)), nextCursor: page.nextCursor };
  }

  @Put('content')
  async putContent(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');

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
    const internalPath = resolveInternalPath(user, body?.path ?? '');
    return this.storixClient.createDownload(internalPath);
  }

  @Post('publish')
  async publish(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    return this.storixClient.publish(internalPath);
  }

  @Delete('publish')
  @HttpCode(204)
  async unpublish(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    await this.storixClient.unpublish(internalPath);
  }
}
