export interface FileEntry {
  readonly path: string;
  readonly name: string;
  readonly type: 'FILE' | 'DIRECTORY';
  readonly size: number | null;
  readonly mimeType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface EntryPage {
  readonly items: FileEntry[];
  readonly nextCursor: string | null;
}
