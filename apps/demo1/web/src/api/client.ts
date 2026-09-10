import type { ApiErrorBody, DemoUser, EntryPage, FileEntry, PresignedDownload, PublicLink } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(status: number, code: string, requestId: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function request<T>(user: DemoUser, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/demo-api${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'X-Demo-User': user },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.code ?? 'UNKNOWN_ERROR',
      body?.requestId ?? '',
      body?.message ?? response.statusText,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function listDocuments(user: DemoUser, path: string, cursor?: string): Promise<EntryPage> {
  const query = new URLSearchParams({ path });
  if (cursor) {
    query.set('cursor', cursor);
  }
  return request(user, `/documents?${query}`);
}

export function searchDocuments(user: DemoUser, path: string, name: string, cursor?: string): Promise<EntryPage> {
  const query = new URLSearchParams({ path, name });
  if (cursor) {
    query.set('cursor', cursor);
  }
  return request(user, `/documents/search?${query}`);
}

export function createDirectory(user: DemoUser, path: string): Promise<void> {
  return request(user, '/directories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export function moveEntry(user: DemoUser, source: string, destination: string): Promise<void> {
  return request(user, '/entries/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, destination }),
  });
}

export function copyEntry(user: DemoUser, source: string, destination: string): Promise<void> {
  return request(user, '/entries/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, destination }),
  });
}

export function removeEntry(user: DemoUser, path: string, recursive: boolean): Promise<void> {
  const query = new URLSearchParams({ path, recursive: String(recursive) });
  return request(user, `/entries?${query}`, { method: 'DELETE' });
}

export function uploadDocument(user: DemoUser, path: string, file: File): Promise<FileEntry> {
  const query = new URLSearchParams({ path });
  return request(user, `/documents/content?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
}

export function createDownload(user: DemoUser, path: string): Promise<PresignedDownload> {
  return request(user, '/documents/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export function publishDocument(user: DemoUser, path: string): Promise<PublicLink> {
  const query = new URLSearchParams({ path });
  return request(user, `/documents/publish?${query}`, { method: 'POST' });
}

export function unpublishDocument(user: DemoUser, path: string): Promise<void> {
  const query = new URLSearchParams({ path });
  return request(user, `/documents/publish?${query}`, { method: 'DELETE' });
}
