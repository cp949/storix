import { MigrationInterface, QueryRunner } from 'typeorm';

// 휴지통 복구가 node의 원래 createdAt을 되살리도록 manifest에 삭제 직전 생성 시각을 보관한다.
// 기존 행은 원래 값을 알 수 없어 null로 두고 복구 시각을 쓴다.
export class AddTrashEntryCreatedAt1791700000024 implements MigrationInterface {
  name = 'AddTrashEntryCreatedAt1791700000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const type = queryRunner.connection.options.type === 'better-sqlite3' ? 'datetime' : 'timestamptz';
    await queryRunner.query(`ALTER TABLE "vfs_trash_entry" ADD COLUMN "created_at" ${type}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "vfs_trash_entry" DROP COLUMN "created_at"');
  }
}
