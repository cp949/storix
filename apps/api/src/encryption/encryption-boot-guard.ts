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

    // 전체 namespace를 세면 시작 시간이 namespace 수에 비례한다. 존재 여부만 확인한다(부분 인덱스
    // `idx_namespace_encrypted`). 개수는 실패 메시지를 만들 때만 센다.
    if (await this.namespaceRepo.exists({ where: { encryptionPolicy: 'ENCRYPTED' } })) {
      const encryptedCount = await this.namespaceRepo.count({ where: { encryptionPolicy: 'ENCRYPTED' } });
      throw new Error(
        `ENCRYPTED namespace가 ${encryptedCount}개 존재하지만 STORIX_ENCRYPTION_MASTER_KEY가 설정되지 않음 — 부팅을 중단한다.`,
      );
    }
  }
}
