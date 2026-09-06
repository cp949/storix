export interface KeysetCursor {
  readonly name: string;
  readonly id: string;
}

function isKeysetCursor(value: unknown): value is KeysetCursor {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): KeysetCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return isKeysetCursor(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
