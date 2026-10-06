import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  listDocuments,
  searchDocuments,
  uploadDocument,
  createUploadSession,
  getUploadSession,
  putUploadSessionPart,
  completeUploadSession,
  cancelUploadSession,
  createDirectory,
  moveEntry,
  removeEntry,
  createDownload,
  publishDocument,
  unpublishDocument,
  setDocumentMimeType,
} from "../../src/api/client";
import type { EntryPage, FileEntry } from "../../src/api/types";
import { ErrorPanel } from "../../src/error/ErrorPanel";
import { ErrorProvider } from "../../src/error/ErrorProvider";
import { DocumentArchive } from "../../src/components/DocumentArchive";
import { FolderTree } from "../../src/components/FolderTree";

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return {
    ...actual,
    listDocuments: vi.fn(),
    searchDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    createUploadSession: vi.fn(),
    getUploadSession: vi.fn(),
    putUploadSessionPart: vi.fn(),
    completeUploadSession: vi.fn(),
    cancelUploadSession: vi.fn(),
    createDirectory: vi.fn(),
    moveEntry: vi.fn(),
    copyEntry: vi.fn(),
    removeEntry: vi.fn(),
    createDownload: vi.fn(),
    publishDocument: vi.fn(),
    unpublishDocument: vi.fn(),
    setDocumentMimeType: vi.fn(),
  };
});

// FolderTree는 자체 테스트(FolderTree.spec.tsx)에서 검증한다. 여기서는
// listDocuments 호출 횟수를 DocumentArchive 자체 로직에만 묶어두기 위해
// 기본은 아무것도 렌더링하지 않는 스텁으로 대체하고, 연동 확인이 필요한
// 테스트에서만 onNavigate를 노출하는 버튼으로 바꿔 끼운다.
vi.mock("../../src/components/FolderTree", () => ({
  FolderTree: vi.fn(() => null),
}));

function page(items: EntryPage["items"]): EntryPage {
  return { items, nextCursor: null };
}

const entryA = {
  path: "/a.txt",
  name: "a.txt",
  type: "FILE" as const,
  size: 1,
  mimeType: "text/plain",
  createdAt: "",
  updatedAt: "",
  version: 1,
};

const dirReports = {
  path: "/reports",
  name: "reports",
  type: "DIRECTORY" as const,
  size: null,
  mimeType: null,
  createdAt: "",
  updatedAt: "",
  version: 1,
};

async function selectRow(text: string) {
  fireEvent.click(await screen.findByText(text, { exact: false }));
}

describe("DocumentArchive", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listDocuments).mockReset();
    vi.mocked(searchDocuments).mockReset();
    vi.mocked(setDocumentMimeType).mockReset();
    vi.mocked(FolderTree).mockClear();
    vi.mocked(FolderTree).mockImplementation(
      (() => null) as unknown as typeof FolderTree,
    );
  });

  it("마운트되면 root 목록을 불러와 표시한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    expect(await screen.findByText("a.txt", { exact: false })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledWith("alice", "/");
  });

  it("선택 파일 MIME type 수정 성공 시 목록 메타데이터를 갱신한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(setDocumentMimeType).mockResolvedValue({
      ...entryA,
      mimeType: "application/json",
      version: 2,
    });

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("MIME type 변경"));
    fireEvent.change(screen.getByLabelText("MIME type"), {
      target: { value: "application/json" },
    });
    fireEvent.click(screen.getByText("저장"));

    await waitFor(() =>
      expect(setDocumentMimeType).toHaveBeenCalledWith(
        "alice",
        "/a.txt",
        "application/json",
      ),
    );
    expect(await screen.findByText("application/json")).toBeTruthy();
  });

  it("사이드바 트리에서 폴더로 이동하면 그 경로로 목록을 다시 불러온다", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce(page([dirReports]));
    vi.mocked(listDocuments).mockResolvedValueOnce(page([]));
    vi.mocked(FolderTree).mockImplementation(({ onNavigate }) => (
      <button type="button" onClick={() => onNavigate("/reports")}>
        tree-nav-reports
      </button>
    ));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() =>
      expect(listDocuments).toHaveBeenCalledWith("alice", "/"),
    );

    fireEvent.click(screen.getByText("tree-nav-reports"));

    await waitFor(() =>
      expect(listDocuments).toHaveBeenCalledWith("alice", "/reports"),
    );
  });

  it("디렉터리를 선택하고 열기를 누르면 그 경로로 목록을 다시 불러온다", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce(page([dirReports]));
    vi.mocked(listDocuments).mockResolvedValueOnce(page([]));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    await selectRow("reports");
    fireEvent.click(screen.getByText("열기"));

    await waitFor(() =>
      expect(listDocuments).toHaveBeenCalledWith("alice", "/reports"),
    );
  });

  it("검색을 실행하면 결과로 목록이 대체되고, 돌아가기를 누르면 원래 목록으로 복귀한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(searchDocuments).mockResolvedValue(
      page([{ ...entryA, path: "/found.txt", name: "found.txt" }]),
    );

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    fireEvent.change(screen.getByLabelText("검색어"), {
      target: { value: "found" },
    });
    fireEvent.click(screen.getByText("검색"));

    expect(await screen.findByText("found.txt", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByText("목록으로 돌아가기"));

    await waitFor(() =>
      expect(screen.queryByText("found.txt", { exact: false })).toBeNull(),
    );
  });

  it("사용자를 전환하면 경로가 root로 리셋되고 새 사용자로 목록을 다시 불러온다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));

    const { rerender } = render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() =>
      expect(listDocuments).toHaveBeenCalledWith("alice", "/"),
    );

    rerender(
      <ErrorProvider>
        <DocumentArchive user="bob" />
      </ErrorProvider>,
    );

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith("bob", "/"));
  });

  it("파일을 선택하면 현재 경로에 업로드하고 성공 후 목록을 새로고침한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(uploadDocument).mockResolvedValue({ ...entryA, size: 5 });

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("파일 업로드"), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith("alice", "/a.txt", file),
    );
    expect(await screen.findByText("업로드 완료")).toBeTruthy();
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });

  it("재개 업로드 완료 후 문서 목록과 폴더 트리를 새로고침한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(searchDocuments).mockResolvedValue(
      page([{ ...entryA, path: "/old.txt", name: "old.txt" }]),
    );
    vi.mocked(createUploadSession).mockResolvedValue({
      sessionId: "33333333-3333-4333-8333-333333333333",
      state: "OPEN",
      partSizeBytes: 4,
      partCount: 1,
      expiresAt: "",
      maxExpiresAt: "",
    });
    vi.mocked(getUploadSession).mockResolvedValue({
      sessionId: "33333333-3333-4333-8333-333333333333",
      state: "OPEN",
      path: "/a.txt",
      sizeBytes: "3",
      mimeType: "text/plain",
      partSizeBytes: 4,
      partCount: 1,
      expiresAt: "",
      maxExpiresAt: "",
      parts: [],
    });
    vi.mocked(putUploadSessionPart).mockResolvedValue({
      index: 0,
      sizeBytes: "3",
      sha256: "a".repeat(64),
      replayed: false,
    });
    vi.mocked(completeUploadSession).mockResolvedValue({
      resource: { ...entryA, size: 3, revision: "r1" },
      affectedRevisions: [],
    });

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("검색어"), {
      target: { value: "old" },
    });
    fireEvent.click(screen.getByText("검색"));
    expect(await screen.findByText("old.txt", { exact: false })).toBeTruthy();
    const initialRefreshKey =
      vi.mocked(FolderTree).mock.lastCall?.[0].refreshKey;
    fireEvent.change(screen.getByLabelText("재개 업로드 파일"), {
      target: { files: [new File(["abc"], "a.txt", { type: "text/plain" })] },
    });

    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("old.txt", { exact: false })).toBeNull();
    expect(vi.mocked(FolderTree).mock.lastCall?.[0].refreshKey).toBe(
      (initialRefreshKey ?? 0) + 1,
    );
  });

  it("완료와 취소 경합에서 서버가 COMPLETED를 반환하면 목록을 새로고침한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(createUploadSession).mockResolvedValue({
      sessionId: "33333333-3333-4333-8333-333333333333",
      state: "OPEN",
      partSizeBytes: 4,
      partCount: 1,
      expiresAt: "",
      maxExpiresAt: "",
    });
    const session = {
      sessionId: "33333333-3333-4333-8333-333333333333",
      state: "OPEN" as const,
      path: "/a.txt",
      sizeBytes: "3",
      mimeType: "text/plain",
      partSizeBytes: 4,
      partCount: 1,
      expiresAt: "",
      maxExpiresAt: "",
      parts: [],
    };
    vi.mocked(getUploadSession)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, state: "COMPLETED" });
    vi.mocked(putUploadSessionPart).mockResolvedValue({
      index: 0,
      sizeBytes: "3",
      sha256: "a".repeat(64),
      replayed: false,
    });
    vi.mocked(completeUploadSession).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(cancelUploadSession).mockRejectedValue(
      new ApiError(409, "VFS_UPLOAD_SESSION_CLOSED", "req-5", "닫힘"),
    );

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("재개 업로드 파일"), {
      target: { files: [new File(["abc"], "a.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(completeUploadSession).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("세션 취소"));

    expect(await screen.findByText("재개 업로드 완료")).toBeTruthy();
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });

  it('업로드가 실패하면 "업로드 실패"를 표시하고 오류를 보고한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(uploadDocument).mockRejectedValue(
      new ApiError(413, "UPLOAD_TOO_LARGE", "req-1", "너무 큼"),
    );

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
        <ErrorPanel />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    const file = new File(["x"], "big.bin");
    fireEvent.change(screen.getByLabelText("파일 업로드"), {
      target: { files: [file] },
    });

    expect(await screen.findByText("업로드 실패")).toBeTruthy();
    expect(await screen.findByText(/413/)).toBeTruthy();
    expect(await screen.findByText(/UPLOAD_TOO_LARGE/)).toBeTruthy();
  });

  it("drag-and-drop으로도 같은 경로에 업로드된다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(uploadDocument).mockResolvedValue({
      ...entryA,
      path: "/b.txt",
      name: "b.txt",
    });

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    const file = new File(["b"], "b.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByText("파일 업로드"), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith("alice", "/b.txt", file),
    );
  });

  it("새 폴더 이름을 입력하고 제출하면 현재 경로 아래에 디렉터리를 만든다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(createDirectory).mockResolvedValue(undefined);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("새 폴더 이름"), {
      target: { value: "reports" },
    });
    fireEvent.click(screen.getByText("폴더 만들기"));

    await waitFor(() =>
      expect(createDirectory).toHaveBeenCalledWith("alice", "/reports"),
    );
  });

  it("항목을 선택하고 이동 버튼을 누르면 prompt로 받은 대상 경로로 이동을 요청한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(moveEntry).mockResolvedValue(undefined);
    vi.spyOn(window, "prompt").mockReturnValue("/archive/a.txt");

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("이동"));

    await waitFor(() =>
      expect(moveEntry).toHaveBeenCalledWith(
        "alice",
        "/a.txt",
        "/archive/a.txt",
      ),
    );
  });

  it("선택 후 삭제는 confirm에서 취소하면 removeEntry를 호출하지 않는다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("삭제"));

    expect(removeEntry).not.toHaveBeenCalled();
  });

  it("root 밖으로 이동을 시도해 403이 나면 오류 패널에 그대로 표시된다(경로 이탈 데모)", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(moveEntry).mockRejectedValue(
      new ApiError(403, "DOCUMENT_PATH_ESCAPES_ROOT", "req-9", "경로 이탈"),
    );
    vi.spyOn(window, "prompt").mockReturnValue("../bob/secret.txt");

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
        <ErrorPanel />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("이동"));

    expect(await screen.findByText(/DOCUMENT_PATH_ESCAPES_ROOT/)).toBeTruthy();
  });

  it("선택 후 다운로드 버튼을 누르면 presigned URL을 새 창으로 연다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(createDownload).mockResolvedValue({
      url: "http://signed.test/x",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("다운로드"));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("http://signed.test/x", "_blank"),
    );
  });

  it("선택 후 발행을 확인하면 공개 링크와 복사/발행취소 버튼이 나타난다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(publishDocument).mockResolvedValue({
      url: "http://public.test/x",
      publicPath: "abcd1234/a.txt",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("발행"));

    expect(await screen.findByText("공개 링크")).toBeTruthy();
    expect(screen.getByText("발행 취소")).toBeTruthy();
  });

  it("발행 확인을 취소하면 publishDocument를 호출하지 않는다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("발행"));

    expect(publishDocument).not.toHaveBeenCalled();
  });

  it("발행 취소를 누르면 공개 링크가 사라지고 다시 발행 버튼이 보인다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(publishDocument).mockResolvedValue({
      url: "http://public.test/x",
      publicPath: "abcd1234/a.txt",
    });
    vi.mocked(unpublishDocument).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow("a.txt");
    fireEvent.click(screen.getByText("발행"));
    fireEvent.click(await screen.findByText("발행 취소"));

    await waitFor(() => expect(screen.queryByText("공개 링크")).toBeNull());
    expect(screen.getByText("발행")).toBeTruthy();
  });
  describe("페이지네이션과 늦은 응답", () => {
    const entryB = { ...entryA, path: "/b.txt", name: "b.txt" };
    const entryInReports = {
      ...entryA,
      path: "/reports/in.txt",
      name: "in.txt",
    };

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    function renderArchive() {
      return render(
        <ErrorProvider>
          <DocumentArchive user="alice" />
          <ErrorPanel />
        </ErrorProvider>,
      );
    }

    async function flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("nextCursor가 있으면 더 보기로 다음 페이지를 목록에 이어 붙인다", async () => {
      vi.mocked(listDocuments)
        .mockResolvedValueOnce({ items: [entryA], nextCursor: "c1" })
        .mockResolvedValueOnce(page([entryB]));

      renderArchive();
      await screen.findByText("a.txt", { exact: false });
      fireEvent.click(screen.getByText("더 보기"));

      expect(await screen.findByText("b.txt", { exact: false })).toBeTruthy();
      expect(screen.getByText("a.txt", { exact: false })).toBeTruthy();
      expect(listDocuments).toHaveBeenLastCalledWith("alice", "/", "c1");
      expect(screen.queryByText("더 보기")).toBeNull();
    });

    it("nextCursor가 null이면 더 보기 버튼을 표시하지 않는다", async () => {
      vi.mocked(listDocuments).mockResolvedValue(page([entryA]));

      renderArchive();
      await screen.findByText("a.txt", { exact: false });

      expect(screen.queryByText("더 보기")).toBeNull();
    });

    it("검색 결과에도 더 보기로 다음 페이지를 이어 붙인다", async () => {
      vi.mocked(listDocuments).mockResolvedValue(page([]));
      vi.mocked(searchDocuments)
        .mockResolvedValueOnce({ items: [entryA], nextCursor: "s1" })
        .mockResolvedValueOnce(page([entryB]));

      renderArchive();
      fireEvent.change(screen.getByLabelText("검색어"), {
        target: { value: "txt" },
      });
      fireEvent.click(screen.getByText("검색"));
      await screen.findByText("a.txt", { exact: false });
      fireEvent.click(screen.getByText("더 보기"));

      expect(await screen.findByText("b.txt", { exact: false })).toBeTruthy();
      expect(searchDocuments).toHaveBeenLastCalledWith(
        "alice",
        "/",
        "txt",
        "s1",
      );
    });

    it("더 보기 요청 중에는 버튼을 비활성화한다", async () => {
      const second = deferred<EntryPage>();
      vi.mocked(listDocuments)
        .mockResolvedValueOnce({ items: [entryA], nextCursor: "c1" })
        .mockReturnValueOnce(second.promise);

      renderArchive();
      await screen.findByText("a.txt", { exact: false });
      fireEvent.click(screen.getByText("더 보기"));

      await waitFor(() =>
        expect(
          (screen.getByText("더 보기") as HTMLButtonElement).disabled,
        ).toBe(true),
      );
      second.resolve(page([entryB]));
      expect(await screen.findByText("b.txt", { exact: false })).toBeTruthy();
    });

    it("더 보기가 실패하면 기존 목록과 버튼을 유지하고 재시도할 수 있다", async () => {
      vi.mocked(listDocuments)
        .mockResolvedValueOnce({ items: [entryA], nextCursor: "c1" })
        .mockRejectedValueOnce(
          new ApiError(500, "STORAGE_FAILURE", "req-2", "실패"),
        )
        .mockResolvedValueOnce(page([entryB]));

      renderArchive();
      await screen.findByText("a.txt", { exact: false });
      fireEvent.click(screen.getByText("더 보기"));

      expect(await screen.findByText(/STORAGE_FAILURE/)).toBeTruthy();
      expect(screen.getByText("a.txt", { exact: false })).toBeTruthy();
      await waitFor(() =>
        expect(
          (screen.getByText("더 보기") as HTMLButtonElement).disabled,
        ).toBe(false),
      );

      fireEvent.click(screen.getByText("더 보기"));
      expect(await screen.findByText("b.txt", { exact: false })).toBeTruthy();
      expect(listDocuments).toHaveBeenLastCalledWith("alice", "/", "c1");
    });

    it("더 보기 응답이 오기 전에 폴더를 이동하면 그 응답을 버린다", async () => {
      const second = deferred<EntryPage>();
      vi.mocked(FolderTree).mockImplementation(({ onNavigate }) => (
        <button type="button" onClick={() => onNavigate("/reports")}>
          tree-nav-reports
        </button>
      ));
      vi.mocked(listDocuments).mockImplementation((_user, path, cursor) => {
        if (path === "/" && cursor === "c1") return second.promise;
        if (path === "/") {
          return Promise.resolve({ items: [entryA], nextCursor: "c1" });
        }
        return Promise.resolve(page([entryInReports]));
      });

      renderArchive();
      await screen.findByText("a.txt", { exact: false });
      fireEvent.click(screen.getByText("더 보기"));
      fireEvent.click(screen.getByText("tree-nav-reports"));
      await screen.findByText("in.txt", { exact: false });

      second.resolve(page([entryB]));
      await flush();

      expect(screen.queryByText("b.txt", { exact: false })).toBeNull();
      expect(screen.getByText("in.txt", { exact: false })).toBeTruthy();
    });

    it("업로드 중 다른 폴더로 이동해도 완료 뒤 목록은 현재 폴더 내용이다", async () => {
      const upload = deferred<FileEntry>();
      vi.mocked(uploadDocument).mockReturnValue(upload.promise);
      vi.mocked(FolderTree).mockImplementation(({ onNavigate }) => (
        <button type="button" onClick={() => onNavigate("/reports")}>
          tree-nav-reports
        </button>
      ));
      vi.mocked(listDocuments).mockImplementation((_user, path) =>
        Promise.resolve(
          path === "/" ? page([dirReports, entryA]) : page([entryInReports]),
        ),
      );

      renderArchive();
      await screen.findByText("a.txt", { exact: false });
      fireEvent.change(screen.getByLabelText("파일 업로드"), {
        target: { files: [new File(["x"], "new.txt")] },
      });
      fireEvent.click(screen.getByText("tree-nav-reports"));
      await screen.findByText("in.txt", { exact: false });

      upload.resolve({ ...entryA, path: "/new.txt", name: "new.txt" });
      await screen.findByText("업로드 완료");
      await flush();

      expect(screen.getByText("in.txt", { exact: false })).toBeTruthy();
      expect(screen.queryByText("a.txt", { exact: false })).toBeNull();
    });

    it("검색 응답이 오기 전에 폴더를 이동하면 늦은 검색 결과를 무시한다", async () => {
      const search = deferred<EntryPage>();
      vi.mocked(FolderTree).mockImplementation(({ onNavigate }) => (
        <button type="button" onClick={() => onNavigate("/reports")}>
          tree-nav-reports
        </button>
      ));
      vi.mocked(listDocuments).mockImplementation((_user, path) =>
        Promise.resolve(path === "/" ? page([entryA]) : page([entryInReports])),
      );
      vi.mocked(searchDocuments).mockReturnValue(search.promise);

      renderArchive();
      await screen.findByText("a.txt", { exact: false });
      fireEvent.change(screen.getByLabelText("검색어"), {
        target: { value: "found" },
      });
      fireEvent.click(screen.getByText("검색"));
      fireEvent.click(screen.getByText("tree-nav-reports"));
      await screen.findByText("in.txt", { exact: false });

      search.resolve(
        page([{ ...entryA, path: "/found.txt", name: "found.txt" }]),
      );
      await flush();

      expect(screen.queryByText("found.txt", { exact: false })).toBeNull();
      expect(screen.getByText("in.txt", { exact: false })).toBeTruthy();
    });
  });
});
