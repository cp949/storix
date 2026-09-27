import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDocuments } from "../api/client";
import type { EntryPage } from "../api/types";
import { FolderTree } from "./FolderTree";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
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

describe("FolderTree", () => {
  beforeEach(() => {
    vi.mocked(listDocuments).mockReset();
  });

  it("마운트되면 root의 하위 디렉터리만 불러와 표시한다(파일은 제외)", async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([reportsDir, aFile]));

    render(
      <FolderTree
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
      <FolderTree
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
      <FolderTree
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
      <FolderTree
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
      <FolderTree
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={0}
      />,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    rerender(
      <FolderTree
        user="alice"
        selectedPath="/"
        onNavigate={vi.fn()}
        refreshKey={1}
      />,
    );

    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });
});
