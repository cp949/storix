import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { VfsNodeRepositoryConditionals } from './vfs-node.repository.conditionals.js';
import { VfsTrashRepository } from './vfs-trash.repository.js';

export * from './vfs-node.repository.types.js';

@Injectable()
export class VfsNodeRepository extends VfsNodeRepositoryConditionals {
  constructor(
    @InjectRepository(NamespaceEntity) namespaceRepo: Repository<NamespaceEntity>,
    @InjectRepository(VfsNodeEntity) nodeRepo: Repository<VfsNodeEntity>,
    @InjectRepository(BlobEntity) blobRepo: Repository<BlobEntity>,
    dataSource: DataSource,
    blobRepository: BlobRepository,
    config: ConfigService,
    trashRepository?: VfsTrashRepository,
  ) {
    super(namespaceRepo, nodeRepo, blobRepo, dataSource, blobRepository, config);
    this.setTrashRepository(trashRepository ?? new VfsTrashRepository(dataSource));
  }
}
