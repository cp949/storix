import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { GcJob } from './gc.job.js';

// job별로 모듈을 분리한다 — NestFactory.createApplicationContext는 import된
// 모듈의 모든 provider를 즉시(eager) 생성하므로, 한 모듈에 세 job을 묶으면
// gc 컨테이너를 띄우는 것만으로 BackupJob/RestoreJob 생성자까지 실행돼
// 그쪽 전용 env var(BACKUP_DIR, RESTORE_SOURCE_DIR) 부재로 부팅이 실패한다.
@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [GcJob],
  exports: [GcJob],
})
export class GcJobModule {}
