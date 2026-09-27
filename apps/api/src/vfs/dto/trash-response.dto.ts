export interface TrashItemDto {
  readonly trashId: string;
  readonly originalPath: string;
  readonly rootType: 'FILE' | 'DIRECTORY';
  readonly deletedAt: string;
  readonly expiresAt: string;
  readonly nodeCount: number;
  readonly logicalBytes: string;
}

export interface TrashPageDto {
  readonly items: TrashItemDto[];
  readonly nextCursor: string | null;
}
