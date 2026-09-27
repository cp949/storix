import type { DemoUser } from '../api/types';

interface StoredUploadSession {
  readonly idempotencyKey: string;
  readonly sessionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeExternalPath(path: string): string {
  const segments = path.trim().split('/').filter(Boolean).map((segment) => segment.normalize('NFC'));
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('업로드 경로에 . 또는 ..을 사용할 수 없습니다.');
  }
  return `/${segments.join('/')}`;
}

export function uploadSessionStorageKey(user: DemoUser, path: string, file: File): string {
  const internalPath = `/documents/${user}${normalizeExternalPath(path)}`;
  return `storix:demo1:upload-session:v1:${JSON.stringify([user, internalPath, file.size, file.lastModified])}`;
}

export function readUploadSession(key: string): StoredUploadSession | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) throw new Error('invalid');
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.idempotencyKey !== 'string' || !UUID.test(candidate.idempotencyKey)
      || (candidate.sessionId !== undefined && (typeof candidate.sessionId !== 'string' || !UUID.test(candidate.sessionId)))) {
      throw new Error('invalid');
    }
    return candidate as unknown as StoredUploadSession;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function saveUploadSession(key: string, session: StoredUploadSession): void {
  localStorage.setItem(key, JSON.stringify(session));
}

export function clearUploadSession(key: string): void {
  localStorage.removeItem(key);
}
