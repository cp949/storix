import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { type CapabilityConfig, loadCapabilityConfig } from './capability-config.js';
import { CapabilityService } from './capability.service.js';
import {
  loadUploadSessionPolicy,
  UPLOAD_SESSION_POLICY,
  type UploadSessionPolicy,
} from '../vfs/upload-session-config.js';

export const CAPABILITY_CONFIG = Symbol('CAPABILITY_CONFIG');

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: CAPABILITY_CONFIG,
      useFactory: async (config: ConfigService, dataSource: DataSource): Promise<CapabilityConfig> => {
        const capabilityConfig = await loadCapabilityConfig(config);
        const namespaces = dataSource.getRepository(NamespaceEntity);
        for (const id of Object.keys(capabilityConfig.namespaceAllowedCapabilities)) {
          if (!(await namespaces.exists({ where: { id } }))) {
            throw new Error(`Capability configuration refers to unknown namespace ID: ${id}`);
          }
        }
        return capabilityConfig;
      },
      inject: [ConfigService, DataSource],
    },
    {
      provide: CapabilityService,
      useFactory: (config: CapabilityConfig): CapabilityService => new CapabilityService(config),
      inject: [CAPABILITY_CONFIG],
    },
    {
      provide: UPLOAD_SESSION_POLICY,
      useFactory: (
        config: ConfigService,
        capabilities: CapabilityConfig,
      ): Promise<UploadSessionPolicy | null> => loadUploadSessionPolicy(config, capabilities),
      inject: [ConfigService, CAPABILITY_CONFIG],
    },
  ],
  exports: [CAPABILITY_CONFIG, CapabilityService, UPLOAD_SESSION_POLICY],
})
export class CapabilityModule {}
