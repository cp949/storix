import type {
  ApiErrorBody,
  DemoUser,
  EntryPage,
  FileEntry,
  PresignedDownload,
  PublicLink,
  UploadPartResult,
  UploadSessionCompleteResult,
  UploadSessionCreated,
  UploadSessionStatus,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(
    status: number,
    code: string,
    requestId: string,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function request<T>(
  user: DemoUser,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/demo-api${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      "X-Demo-User": user,
    },
  });

  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.code ?? "UNKNOWN_ERROR",
      body?.requestId ?? "",
      body?.message ?? response.statusText,
    );
  }

  // 204는 물론, 본문 없는 성공 응답(예: 백엔드가 실수로 204 대신 기본
  // 상태코드를 반환하는 경우)도 JSON.parse가 빈 문자열에서 SyntaxError를
  // 던지지 않도록 파싱 전에 본문 존재 여부를 먼저 확인한다.
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function listDocuments(
  user: DemoUser,
  path: string,
  cursor?: string,
): Promise<EntryPage> {
  const query = new URLSearchParams({ path });
  if (cursor) {
    query.set("cursor", cursor);
  }
  return request(user, `/documents?${query}`);
}

export function searchDocuments(
  user: DemoUser,
  path: string,
  name: string,
  cursor?: string,
): Promise<EntryPage> {
  const query = new URLSearchParams({ path, name });
  if (cursor) {
    query.set("cursor", cursor);
  }
  return request(user, `/documents/search?${query}`);
}

export function createDirectory(user: DemoUser, path: string): Promise<void> {
  return request(user, "/directories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function moveEntry(
  user: DemoUser,
  source: string,
  destination: string,
): Promise<void> {
  return request(user, "/entries/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, destination }),
  });
}

export function copyEntry(
  user: DemoUser,
  source: string,
  destination: string,
): Promise<void> {
  return request(user, "/entries/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, destination }),
  });
}

export function removeEntry(
  user: DemoUser,
  path: string,
  recursive: boolean,
): Promise<void> {
  const query = new URLSearchParams({ path, recursive: String(recursive) });
  return request(user, `/entries?${query}`, { method: "DELETE" });
}

export function uploadDocument(
  user: DemoUser,
  path: string,
  file: File,
): Promise<FileEntry> {
  const query = new URLSearchParams({ path });
  return request(user, `/documents/content?${query}`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
}

export function createUploadSession(
  user: DemoUser,
  path: string,
  file: File,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<UploadSessionCreated> {
  return request(user, "/documents/upload-sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      path,
      sizeBytes: String(file.size),
      mimeType: file.type || "application/octet-stream",
      ifAbsent: true,
    }),
    signal,
  });
}

export function getUploadSession(
  user: DemoUser,
  sessionId: string,
  signal?: AbortSignal,
): Promise<UploadSessionStatus> {
  return request(
    user,
    `/documents/upload-sessions/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

export function putUploadSessionPart(
  user: DemoUser,
  sessionId: string,
  index: number,
  part: Blob,
  signal?: AbortSignal,
): Promise<UploadPartResult> {
  // 브라우저는 Content-Length 설정을 금지한다. Blob 크기로 정확한 길이를 자동 전송한다.
  return request(
    user,
    `/documents/upload-sessions/${encodeURIComponent(sessionId)}/parts/${index}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: part,
      signal,
    },
  );
}

export function completeUploadSession(
  user: DemoUser,
  sessionId: string,
  signal?: AbortSignal,
): Promise<UploadSessionCompleteResult> {
  return request(
    user,
    `/documents/upload-sessions/${encodeURIComponent(sessionId)}/complete`,
    {
      method: "POST",
      signal,
    },
  );
}

export function cancelUploadSession(
  user: DemoUser,
  sessionId: string,
): Promise<UploadSessionStatus> {
  return request(
    user,
    `/documents/upload-sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function createDownload(
  user: DemoUser,
  path: string,
): Promise<PresignedDownload> {
  return request(user, "/documents/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function publishDocument(
  user: DemoUser,
  path: string,
): Promise<PublicLink> {
  const query = new URLSearchParams({ path });
  return request(user, `/documents/publish?${query}`, { method: "POST" });
}

export function unpublishDocument(user: DemoUser, path: string): Promise<void> {
  const query = new URLSearchParams({ path });
  return request(user, `/documents/publish?${query}`, { method: "DELETE" });
}
