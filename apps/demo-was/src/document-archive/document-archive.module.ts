import { Module } from '@nestjs/common';
import { StorixClientModule } from '../storix-client/storix-client.module.js';
import { BootstrapService } from './bootstrap.service.js';

@Module({
  imports: [StorixClientModule],
  providers: [BootstrapService],
})
export class DocumentArchiveModule {}
