import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, listDocuments } from "../../src/api/client";
import type { EntryPage } from "../../src/api/types";
import { ErrorPanel } from "../../src/error/ErrorPanel";
import { ErrorProvider } from "../../src/error/ErrorProvider";
import { FolderTree } from "../../src/components/FolderTree";

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, listDocuments: vi.fn() };
});

function page(items: EntryPage["items"]): EntryPage {
  return { items, nextCursor: null };
}

const reportsDir = {
  path: "/reports",
  name: "reports",
  type: "DIRECTORY" as const,
  size: null,
  mimeType: null,
  createdAt: "",
  updatedAt: "",
  version: 1,
};

const aFile = {
  path: "/a.txt",
  name: "a.txt",
  type: "FILE" as const,
  size: 1,
  mimeType: "text/plain",
  createdAt: "",
  updatedAt: "",
  version: 1,
};

const reports2024Dir = {
  ...reportsDir,
  path: "/reports/2024",
  name: "2024",
};

function TreeWithProvider(props: ComponentProps<typeof FolderTree>) {
  return (
    <ErrorProvider>
      <FolderTree {...props} />
      <ErrorPanel />
    </ErrorProvider>
  );
}

describe("FolderTree", () => {
  beforeEach(() => {
    vi.mocked(listDocuments).mockReset();
  });

  it("마운트되면 root의 하위 디렉터리만 불러와 표시한다(파일은 제외)", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([reportsDir, aFile]));

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );

    expect(await screen.findByText("reports", { exact: false })).toBeTruthy();
    expect(screen.queryByText("a.txt")).toBeNull();
    expect(listDocuments).toHaveBeenCalledWith("alice", "/");
  });

  it("폴더 이름을 클릭하면 onNavigate가 그 경로로 호출된다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([reportsDir]));
    const onNavigate = vi.fn();

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={onNavigate}
        refreshKey={0}
      />,
    );
    fireEvent.click(await screen.findByText("reports", { exact: false }));

    expect(onNavigate).toHaveBeenCalledWith("/reports");
  });

  it("펼치기 버튼을 누르면 그 폴더의 하위 폴더를 지연 로드한다", async () => {
    vi.mocked(listDocuments).mockImplementation((_user, path) => {
      if (path === "/") return Promise.resolve(page([reportsDir]));
      if (path === "/reports") return Promise.resolve(page([reports2024Dir]));
      return Promise.resolve(page([]));
    });

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );
    await screen.findByText("reports", { exact: false });
    expect(listDocuments).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("reports 펼치기"));

    expect(await screen.findByText("2024", { exact: false })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledWith("alice", "/reports");
  });

  it("selectedPath와 일치하는 노드를 현재 위치로 표시한다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([reportsDir]));

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/reports"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );

    const node = await screen.findByText("reports", { exact: false });
    expect(node.getAttribute("aria-current")).toBe("true");
    const root = screen.getByText("root", { exact: false });
    expect(root.getAttribute("aria-current")).toBeNull();
  });

  it("refreshKey가 바뀌면 펼쳐진 노드를 다시 불러온다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([reportsDir]));

    const { rerender } = render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    rerender(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={1}
      />,
    );

    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });
  it("한 페이지에 폴더가 없어도 nextCursor가 있으면 더 보기로 다음 페이지를 불러온다", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ items: [aFile], nextCursor: "c1" })
      .mockResolvedValueOnce(page([reportsDir]));

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );
    fireEvent.click(await screen.findByLabelText("root 더 보기"));

    expect(await screen.findByText("reports", { exact: false })).toBeTruthy();
    expect(listDocuments).toHaveBeenLastCalledWith("alice", "/", "c1");
    expect(screen.queryByLabelText("root 더 보기")).toBeNull();
  });

  it("nextCursor가 null이면 더 보기 버튼을 표시하지 않는다", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([reportsDir]));

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );
    await screen.findByText("reports", { exact: false });

    expect(screen.queryByLabelText("root 더 보기")).toBeNull();
  });

  it("조회가 실패하면 오류를 보고하고 노드는 빈 상태로 둔다", async () => {
    vi.mocked(listDocuments).mockRejectedValue(
      new ApiError(500, "STORAGE_FAILURE", "req-1", "실패"),
    );

    render(
      <TreeWithProvider
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );

    expect(await screen.findByText(/STORAGE_FAILURE/)).toBeTruthy();
    expect(screen.queryByText("불러오는 중...")).toBeNull();
  });
});
