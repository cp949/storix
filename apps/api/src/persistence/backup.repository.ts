import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from './entities/namespace.entity.js';

@Injectable()
export class BackupRepository {
  constructor(private readonly dataSource: DataSource) {}

  async countEncryptedNamespaces(): Promise<number> {
    return this.dataSource.getRepository(NamespaceEntity).count({ where: { encryptionPolicy: 'ENCRYPTED' } });
  }

  // "복구 대상이 비어있는가"의 판단 기준은 스키마 존재 여부가 아니라 실제
  // namespace 데이터 존재 여부다. docker-compose에서 restore 서비스는 항상
  // migrate 완료 후 실행되므로(schema는 이미 존재) 테이블 존재 자체를 기준으로
  // 삼으면 정상적인 "새 인스턴스에 최초 복구" 시나리오까지 매번 거부하게 된다.
  async hasExistingNamespaces(): Promise<boolean> {
    const count = await this.dataSource.getRepository(NamespaceEntity).count();
    return count > 0;
  }
}
