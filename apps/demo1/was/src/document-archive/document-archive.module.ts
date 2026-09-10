import { Module } from '@nestjs/common';
import { StorixClientModule } from '../storix-client/storix-client.module.js';
import { BootstrapService } from './bootstrap.service.js';
import { DirectoriesController } from './directories.controller.js';
import { DocumentsController } from './documents.controller.js';
import { EntriesController } from './entries.controller.js';

@Module({
  imports: [StorixClientModule],
  controllers: [DocumentsController, DirectoriesController, EntriesController],
  providers: [BootstrapService],
})
export class DocumentArchiveModule {}
