import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StorixClient } from '../storix-client/storix-client.service.js';

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(private readonly storixClient: StorixClient) {}

  async onModuleInit(): Promise<void> {
    const demoNamespaceId = await this.storixClient.ensureDemoNamespace();
    const publicNamespaceId = await this.storixClient.ensurePublicNamespace();
    this.logger.log(`namespace 준비 완료: demo=${demoNamespaceId}, public=${publicNamespaceId}`);
  }
}
