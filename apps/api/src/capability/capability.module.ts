import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { type CapabilityConfig, loadCapabilityConfig } from './capability-config.js';
import { CapabilityService } from './capability.service.js';
import { findMissingNamespaceIds } from './namespace-existence.js';
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
        // 설정에 적힌 namespace가 모두 있는지 항목 수와 무관한 질의 횟수로 확인한다.
        const missing = await findMissingNamespaceIds(
          dataSource,
          Object.keys(capabilityConfig.namespaceAllowedCapabilities),
        );
        if (missing.length > 0) {
          throw new Error(`Capability configuration refers to unknown namespace ID: ${missing[0]}`);
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
