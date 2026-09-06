import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { MASTER_KEY } from './encryption.constants.js';

@Injectable()
export class EncryptionBootGuard implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(NamespaceEntity) private readonly namespaceRepo: Repository<NamespaceEntity>,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.masterKey) {
      return;
    }

    const encryptedCount = await this.namespaceRepo.count({ where: { encryptionPolicy: 'ENCRYPTED' } });
    if (encryptedCount > 0) {
      throw new Error(
        `ENCRYPTED namespace가 ${encryptedCount}개 존재하지만 ENCRYPTION_MASTER_KEY가 설정되지 않음 — 부팅을 중단한다.`,
      );
    }
  }
}
