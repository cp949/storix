import { Module } from '@nestjs/common';
import { StorixClient } from './storix-client.service.js';
import { StorixHttpClient } from './storix-http.client.js';

@Module({
  providers: [StorixHttpClient, StorixClient],
  exports: [StorixClient],
})
export class StorixClientModule {}
