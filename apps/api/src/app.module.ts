import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module.js';
import { NamespaceModule } from './namespace/namespace.module.js';
import { VfsModule } from './vfs/vfs.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule, NamespaceModule, VfsModule],
})
export class AppModule {}
