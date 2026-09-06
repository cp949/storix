import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { NamespaceModule } from './namespace/namespace.module.js';
import { VfsModule } from './vfs/vfs.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, HealthModule, NamespaceModule, VfsModule],
})
export class AppModule {}
