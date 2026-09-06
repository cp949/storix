import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { EncryptionBootGuard } from './encryption-boot-guard.js';
import { MASTER_KEY } from './encryption.constants.js';
import { parseMasterKey } from './master-key.js';

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: MASTER_KEY,
      useFactory: (config: ConfigService) => parseMasterKey(config.get<string>('ENCRYPTION_MASTER_KEY')),
      inject: [ConfigService],
    },
    EncryptionBootGuard,
  ],
  exports: [MASTER_KEY],
})
export class EncryptionModule {}
