const MIME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/;
const DEFAULT_MIME_TYPE = 'application/octet-stream';

export function normalizeMimeType(raw: string | undefined): string {
  if (!raw) {
    return DEFAULT_MIME_TYPE;
  }

  const primary = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_PATTERN.test(primary) ? primary : DEFAULT_MIME_TYPE;
}
