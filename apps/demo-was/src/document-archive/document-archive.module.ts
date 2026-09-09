import { Module } from '@nestjs/common';
import { StorixClientModule } from '../storix-client/storix-client.module.js';
import { BootstrapService } from './bootstrap.service.js';
import { DocumentsController } from './documents.controller.js';

@Module({
  imports: [StorixClientModule],
  controllers: [DocumentsController],
  providers: [BootstrapService],
})
export class DocumentArchiveModule {}
