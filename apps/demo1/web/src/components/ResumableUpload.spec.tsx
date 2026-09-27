import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  cancelUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  putUploadSessionPart,
} from "../api/client";
import type { UploadSessionStatus } from "../api/types";
import { ErrorProvider } from "../error/ErrorProvider";
import { ResumableUpload } from "./ResumableUpload";
import {
  readUploadSession,
  uploadSessionStorageKey,
} from "./upload-session-storage";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createUploadSession: vi.fn(),
    getUploadSession: vi.fn(),
    putUploadSessionPart: vi.fn(),
    completeUploadSession: vi.fn(),
    cancelUploadSession: vi.fn(),
  };
});

const sessionId = "33333333-3333-4333-8333-333333333333";
const status: UploadSessionStatus = {
  sessionId,
  state: "OPEN",
  path: "/large.bin",
  sizeBytes: "10",
  mimeType: "application/octet-stream",
  partSizeBytes: 4,
  partCount: 3,
  expiresAt: "2026-10-01T00:00:00.000Z",
  maxExpiresAt: "2026-10-07T00:00:00.000Z",
  parts: [],
};

function file(lastModified = 100): File {
  return new File(["abcdefghij"], "large.bin", {
    type: "application/octet-stream",
    lastModified,
  });
}

function selectFile(selected = file()) {
  fireEvent.change(screen.getByLabelText("재개 업로드 파일"), {
    target: { files: [selected] },
  });
}

function renderUpload(
  user: "alice" | "bob" = "alice",
  currentPath = "/",
  onComplete = vi.fn().mockResolvedValue(undefined),
) {
  return render(
    <ErrorProvider>
      <ResumableUpload
        user={user}
        currentPath={currentPath}
        onComplete={onComplete}
      />
    </ErrorProvider>,
  );
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("ResumableUpload", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of [
      createUploadSession,
      getUploadSession,
      putUploadSessionPart,
      completeUploadSession,
      cancelUploadSession,
    ]) {
      vi.mocked(mock).mockReset();
    }
    vi.mocked(createUploadSession).mockResolvedValue({
      sessionId,
      state: "OPEN",
      partSizeBytes: 4,
      partCount: 3,
      expiresAt: status.expiresAt,
      maxExpiresAt: status.maxExpiresAt,
    });
    vi.mocked(getUploadSession).mockResolvedValue(status);
    vi.mocked(putUploadSessionPart).mockResolvedValue({
      index: 0,
      sizeBytes: "4",
      sha256: "a".repeat(64),
      replayed: false,
    });
    vi.mocked(completeUploadSession).mockResolvedValue({
      resource: {} as never,
      affectedRevisions: [],
    });
    vi.mocked(cancelUploadSession).mockResolvedValue({
      ...status,
      state: "CANCELLED",
    });
  });

  it("서버 part 크기로 File.slice 조각을 순서대로 보내고 완료한다", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    renderUpload("alice", "/", onComplete);
    selectFile();

    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    expect(createUploadSession).toHaveBeenCalledWith(
      "alice",
      "/large.bin",
      expect.any(File),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(
      vi.mocked(putUploadSessionPart).mock.calls.map((call) => call[2]),
    ).toEqual([0, 1, 2]);
    const chunks = vi
      .mocked(putUploadSessionPart)
      .mock.calls.map((call) => call[3]);
    expect(await Promise.all(chunks.map(readBlob))).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", file())),
    ).toBeNull();
  });

  it("서버 상태에 저장된 조각은 다시 보내지 않는다", async () => {
    vi.mocked(getUploadSession).mockResolvedValue({
      ...status,
      parts: [
        { index: 0, sizeBytes: "4" },
        { index: 2, sizeBytes: "2" },
      ],
    });
    renderUpload();
    selectFile();

    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    expect(
      vi.mocked(putUploadSessionPart).mock.calls.map((call) => call[2]),
    ).toEqual([1]);
  });

  it("조각 실패 후 같은 파일을 재선택하면 기존 세션을 조회하고 누락 조각부터 재개한다", async () => {
    vi.mocked(putUploadSessionPart)
      .mockResolvedValueOnce({
        index: 0,
        sizeBytes: "4",
        sha256: "a".repeat(64),
        replayed: false,
      })
      .mockRejectedValueOnce(
        new ApiError(503, "STORAGE_UNAVAILABLE", "req-1", "재시도"),
      );
    vi.mocked(getUploadSession)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({
        ...status,
        parts: [{ index: 0, sizeBytes: "4" }],
      });
    renderUpload();
    selectFile();
    expect(await screen.findByText("재개 업로드 실패")).toBeTruthy();
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", file()))
        ?.sessionId,
    ).toBe(sessionId);

    selectFile();
    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    expect(createUploadSession).toHaveBeenCalledTimes(1);
    expect(getUploadSession).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(putUploadSessionPart).mock.calls.map((call) => call[2]),
    ).toEqual([0, 1, 1, 2]);
  });

  it("없는 세션을 발견하면 저장 참조를 지우고 같은 파일 재선택을 안내한다", async () => {
    vi.mocked(getUploadSession).mockRejectedValue(
      new ApiError(404, "VFS_UPLOAD_SESSION_NOT_FOUND", "req-2", "세션 없음"),
    );
    renderUpload();
    selectFile();

    expect(await screen.findByText("재개 업로드 실패")).toBeTruthy();
    expect(
      screen.getByText(/같은 파일을 다시 선택해 새로 시작하세요/),
    ).toBeTruthy();
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", file())),
    ).toBeNull();
  });

  it("중단 후 세션 취소 시 서버 DELETE와 저장 참조 정리를 수행한다", async () => {
    vi.mocked(putUploadSessionPart).mockImplementation(
      () => new Promise(() => {}),
    );
    renderUpload();
    selectFile();
    await waitFor(() => expect(putUploadSessionPart).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("중단"));
    fireEvent.click(screen.getByText("세션 취소"));

    await waitFor(() =>
      expect(cancelUploadSession).toHaveBeenCalledWith("alice", sessionId),
    );
    await waitFor(() =>
      expect(
        readUploadSession(
          uploadSessionStorageKey("alice", "/large.bin", file()),
        ),
      ).toBeNull(),
    );
  });

  it("WAS와 동일하게 경로 끝 공백을 정규화해 생성과 세션 상태를 비교한다", async () => {
    renderUpload();
    selectFile(
      new File(["abcdefghij"], "large.bin ", {
        type: "application/octet-stream",
        lastModified: 100,
      }),
    );

    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    expect(createUploadSession).toHaveBeenCalledWith(
      "alice",
      "/large.bin",
      expect.any(File),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("취소 응답을 기다리는 동안 다른 파일을 선택해도 새 업로드 상태와 참조를 보존한다", async () => {
    let finishCancel: (value: UploadSessionStatus) => void = () => {};
    vi.mocked(cancelUploadSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    const secondId = "44444444-4444-4444-8444-444444444444";
    vi.mocked(createUploadSession)
      .mockResolvedValueOnce({
        sessionId,
        state: "OPEN",
        partSizeBytes: 4,
        partCount: 3,
        expiresAt: status.expiresAt,
        maxExpiresAt: status.maxExpiresAt,
      })
      .mockResolvedValueOnce({
        sessionId: secondId,
        state: "OPEN",
        partSizeBytes: 4,
        partCount: 3,
        expiresAt: status.expiresAt,
        maxExpiresAt: status.maxExpiresAt,
      });
    vi.mocked(getUploadSession)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({
        ...status,
        sessionId: secondId,
        path: "/other.bin",
      });
    vi.mocked(putUploadSessionPart).mockImplementation(
      () => new Promise(() => {}),
    );
    renderUpload();
    selectFile();
    await waitFor(() => expect(putUploadSessionPart).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("세션 취소"));
    fireEvent.click(screen.getByText("세션 취소"));
    expect(cancelUploadSession).toHaveBeenCalledTimes(1);
    const other = new File(["abcdefghij"], "other.bin", {
      type: "application/octet-stream",
      lastModified: 100,
    });
    selectFile(other);
    await waitFor(() => expect(putUploadSessionPart).toHaveBeenCalledTimes(2));
    finishCancel({ ...status, state: "CANCELLED" });

    await waitFor(() =>
      expect(
        readUploadSession(
          uploadSessionStorageKey("alice", "/large.bin", file()),
        ),
      ).toBeNull(),
    );
    expect(cancelUploadSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/재개 업로드중/)).toBeTruthy();
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/other.bin", other))
        ?.sessionId,
    ).toBe(secondId);
  });

  it("취소 중 같은 파일을 재선택하면 취소 결과를 기다린 뒤 새 세션을 만든다", async () => {
    let finishCancel: (value: UploadSessionStatus) => void = () => {};
    vi.mocked(cancelUploadSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    const secondId = "44444444-4444-4444-8444-444444444444";
    vi.mocked(createUploadSession)
      .mockResolvedValueOnce({
        sessionId,
        state: "OPEN",
        partSizeBytes: 4,
        partCount: 3,
        expiresAt: status.expiresAt,
        maxExpiresAt: status.maxExpiresAt,
      })
      .mockResolvedValueOnce({
        sessionId: secondId,
        state: "OPEN",
        partSizeBytes: 4,
        partCount: 3,
        expiresAt: status.expiresAt,
        maxExpiresAt: status.maxExpiresAt,
      });
    vi.mocked(getUploadSession)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, sessionId: secondId });
    vi.mocked(putUploadSessionPart).mockImplementation(
      () => new Promise(() => {}),
    );
    renderUpload();
    selectFile();
    await waitFor(() => expect(putUploadSessionPart).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("세션 취소"));
    selectFile();
    expect(createUploadSession).toHaveBeenCalledTimes(1);

    finishCancel({ ...status, state: "CANCELLED" });
    await waitFor(() => expect(createUploadSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(putUploadSessionPart).toHaveBeenCalledTimes(2));
    expect(cancelUploadSession).toHaveBeenCalledTimes(1);
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", file()))
        ?.sessionId,
    ).toBe(secondId);
  });

  it("완료 요청과 취소가 겹쳐 FINALIZING이면 세션 참조를 보존한다", async () => {
    vi.mocked(completeUploadSession).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(cancelUploadSession).mockRejectedValue(
      new ApiError(409, "VFS_UPLOAD_SESSION_CLOSED", "req-3", "닫힘"),
    );
    vi.mocked(getUploadSession)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, state: "FINALIZING" });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    renderUpload("alice", "/", onComplete);
    selectFile();
    await waitFor(() => expect(completeUploadSession).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("세션 취소"));

    expect(
      await screen.findByText(/서버에서 업로드를 마무리하고 있습니다/),
    ).toBeTruthy();
    expect(getUploadSession).toHaveBeenCalledTimes(2);
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", file()))
        ?.sessionId,
    ).toBe(sessionId);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("완료 요청과 취소가 겹쳐 COMPLETED이면 참조를 정리하고 완료 callback을 호출한다", async () => {
    vi.mocked(completeUploadSession).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(cancelUploadSession).mockRejectedValue(
      new ApiError(409, "VFS_UPLOAD_SESSION_CLOSED", "req-4", "닫힘"),
    );
    vi.mocked(getUploadSession)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, state: "COMPLETED" });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    renderUpload("alice", "/", onComplete);
    selectFile();
    await waitFor(() => expect(completeUploadSession).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("세션 취소"));

    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    expect(screen.queryByText("세션 취소 중...")).toBeNull();
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", file())),
    ).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
