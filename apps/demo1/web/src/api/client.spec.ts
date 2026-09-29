import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createDirectory,
  createUploadSession,
  getUploadSession,
  putUploadSessionPart,
  completeUploadSession,
  cancelUploadSession,
  listDocuments,
  setDocumentMimeType,
} from "./client";

describe("listDocuments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("X-Demo-User 헤더와 path 쿼리를 붙여 demo-api를 호출한다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
      }),
    );

    await listDocuments("alice", "/reports");

    const [input, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("/demo-api/documents?path=%2Freports");
    expect((init.headers as Record<string, string>)["X-Demo-User"]).toBe(
      "alice",
    );
  });

  it("응답이 실패하면 ApiError로 status/code/requestId를 담아 던진다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "DEMO_USER_REQUIRED",
          message: "헤더 없음",
          requestId: "req-1",
        }),
        {
          status: 400,
        },
      ),
    );

    const error = await listDocuments("alice", "/").catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "DEMO_USER_REQUIRED",
      requestId: "req-1",
    });
  });
});

describe("createDirectory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("204 No Content 응답을 파싱 시도 없이 처리한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(createDirectory("alice", "/reports")).resolves.toBeUndefined();
  });

  it("본문 없는 201 응답도(구현이 실수로 되돌아가도) JSON 파싱 에러 없이 처리한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 201 }),
    );

    await expect(createDirectory("alice", "/reports")).resolves.toBeUndefined();
  });
});

describe("setDocumentMimeType", () => {
  afterEach(() => vi.restoreAllMocks());

  it("path와 MIME type을 JSON body로 보내고 갱신된 파일을 반환한다", async () => {
    const file = { path: "/a.txt", mimeType: "application/json" };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(file), { status: 200 }));

    await expect(
      setDocumentMimeType("alice", "/a.txt", "application/json"),
    ).resolves.toEqual(file);

    const [route, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(route).toBe("/demo-api/documents/mime-type");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Demo-User": "alice",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      path: "/a.txt",
      mimeType: "application/json",
    });
  });
});

describe("upload sessions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("생성 시 UUID key와 크기 문자열, ifAbsent 조건을 보낸다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "session-1",
          state: "OPEN",
          partSizeBytes: 4,
          partCount: 2,
        }),
        { status: 201 },
      ),
    );
    const file = new File(["abcdef"], "a.bin");

    await createUploadSession(
      "alice",
      "/a.bin",
      file,
      "33333333-3333-4333-8333-333333333333",
    );

    const [route, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(route).toBe("/demo-api/documents/upload-sessions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-Demo-User": "alice",
      "Idempotency-Key": "33333333-3333-4333-8333-333333333333",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      path: "/a.bin",
      sizeBytes: "6",
      mimeType: "application/octet-stream",
      ifAbsent: true,
    });
  });

  it("상태, Blob 조각, 완료, 취소에 정확한 라우트와 전송 형식을 사용한다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    const part = new Blob(["abcd"]);
    await getUploadSession("alice", "session-1");
    await putUploadSessionPart("alice", "session-1", 2, part);
    await completeUploadSession("alice", "session-1");
    await cancelUploadSession("alice", "session-1");

    expect(fetchSpy.mock.calls.map(([route]) => route)).toEqual([
      "/demo-api/documents/upload-sessions/session-1",
      "/demo-api/documents/upload-sessions/session-1/parts/2",
      "/demo-api/documents/upload-sessions/session-1/complete",
      "/demo-api/documents/upload-sessions/session-1",
    ]);
    const partInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(partInit.method).toBe("PUT");
    expect(partInit.body).toBe(part);
    expect(partInit.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      "X-Demo-User": "alice",
    });
    expect(
      (partInit.headers as Record<string, string>)["Content-Length"],
    ).toBeUndefined();
    expect((fetchSpy.mock.calls[2][1] as RequestInit).method).toBe("POST");
    expect((fetchSpy.mock.calls[3][1] as RequestInit).method).toBe("DELETE");
  });
});
