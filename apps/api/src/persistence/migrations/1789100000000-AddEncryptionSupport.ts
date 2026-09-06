import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEncryptionSupport1789100000000 implements MigrationInterface {
  name = 'AddEncryptionSupport1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_encryption_policy";
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_encryption_policy"
        CHECK ("encryption_policy" IN ('NONE', 'ENCRYPTED'));
    `);
    await queryRunner.query(`
      ALTER TABLE "blob" ADD COLUMN "encryption_iv" bytea;
    `);
    await queryRunner.query(`
      ALTER TABLE "blob" ADD CONSTRAINT "CHK_blob_encryption_iv_length"
        CHECK ("encryption_iv" IS NULL OR octet_length("encryption_iv") = 16);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "blob" DROP CONSTRAINT "CHK_blob_encryption_iv_length";`);
    await queryRunner.query(`ALTER TABLE "blob" DROP COLUMN "encryption_iv";`);
    await queryRunner.query(`ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_encryption_policy";`);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" = 'NONE');
    `);
  }
}
