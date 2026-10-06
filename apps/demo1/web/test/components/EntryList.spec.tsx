import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileEntry, PublicLink } from "../../src/api/types";
import { EntryList } from "../../src/components/EntryList";

const fileA: FileEntry = {
  path: "/a.txt",
  name: "a.txt",
  type: "FILE",
  size: 1,
  mimeType: "text/plain",
  createdAt: "",
  updatedAt: "",
  version: 1,
};

const dirReports: FileEntry = {
  path: "/reports",
  name: "reports",
  type: "DIRECTORY",
  size: null,
  mimeType: null,
  createdAt: "",
  updatedAt: "",
  version: 1,
};

function noop() {
  /* 테스트에서 호출 여부만 확인하는 핸들러 자리 */
}

interface OverrideProps {
  items?: FileEntry[];
  selectedPath?: string | null;
  loading?: boolean;
  publishedLinks?: Record<string, PublicLink>;
  onSelect?: (item: FileEntry) => void;
  onOpenDirectory?: (item: FileEntry) => void;
  onMove?: (item: FileEntry) => void;
  onCopy?: (item: FileEntry) => void;
  onRemove?: (item: FileEntry) => void;
  onDownload?: (item: FileEntry) => void;
  onPublish?: (item: FileEntry) => void;
  onUnpublish?: (item: FileEntry) => void;
  onCopyLink?: (url: string) => void;
  onSetMimeType?: (item: FileEntry, mimeType: string) => void;
}

function renderList(overrides: OverrideProps = {}) {
  const props = {
    items: overrides.items ?? [fileA],
    selectedPath: overrides.selectedPath ?? null,
    loading: overrides.loading ?? false,
    publishedLinks: overrides.publishedLinks ?? {},
    onSelect: overrides.onSelect ?? noop,
    onOpenDirectory: overrides.onOpenDirectory ?? noop,
    onMove: overrides.onMove ?? noop,
    onCopy: overrides.onCopy ?? noop,
    onRemove: overrides.onRemove ?? noop,
    onDownload: overrides.onDownload ?? noop,
    onPublish: overrides.onPublish ?? noop,
    onUnpublish: overrides.onUnpublish ?? noop,
    onCopyLink: overrides.onCopyLink ?? noop,
    onSetMimeType: overrides.onSetMimeType ?? noop,
  };
  return render(<EntryList {...props} />);
}

describe("EntryList", () => {
  it("항목이 없고 로딩 중이 아니면 빈 폴더 안내를 보여준다", () => {
    renderList({ items: [] });
    expect(screen.getByText("이 폴더는 비어 있습니다.")).toBeTruthy();
  });

  it("로딩 중에는 로딩 문구를 보여준다", () => {
    renderList({ items: [], loading: true });
    expect(screen.getByText("불러오는 중...")).toBeTruthy();
  });

  it("선택된 항목이 없으면 작업 툴바가 보이지 않는다", () => {
    renderList({ selectedPath: null });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("행을 클릭하면 onSelect가 그 항목으로 호출된다", () => {
    const onSelect = vi.fn();
    renderList({ onSelect });

    fireEvent.click(screen.getByText("a.txt", { exact: false }));

    expect(onSelect).toHaveBeenCalledWith(fileA);
  });

  it("파일을 선택하면 이동·복사·삭제·다운로드·발행 버튼이 나타난다", () => {
    renderList({ selectedPath: "/a.txt" });

    const toolbar = screen.getByRole("toolbar");
    expect(within(toolbar).getByText("이동")).toBeTruthy();
    expect(within(toolbar).getByText("복사")).toBeTruthy();
    expect(within(toolbar).getByText("삭제")).toBeTruthy();
    expect(within(toolbar).getByText("다운로드")).toBeTruthy();
    expect(within(toolbar).getByText("발행")).toBeTruthy();
    expect(within(toolbar).getByText("MIME type 변경")).toBeTruthy();
    expect(within(toolbar).queryByText("열기")).toBeNull();
  });

  it("선택한 파일 MIME type을 수정 요청한다", () => {
    const onSetMimeType = vi.fn();
    renderList({ selectedPath: "/a.txt", onSetMimeType });

    fireEvent.click(screen.getByText("MIME type 변경"));
    fireEvent.change(screen.getByLabelText("MIME type"), {
      target: { value: "application/json" },
    });
    fireEvent.click(screen.getByText("저장"));

    expect(onSetMimeType).toHaveBeenCalledWith(fileA, "application/json");
  });

  it("디렉터리를 선택하면 열기·이동·복사·삭제만 나타나고 다운로드·발행은 없다", () => {
    renderList({ items: [dirReports], selectedPath: "/reports" });

    const toolbar = screen.getByRole("toolbar");
    expect(within(toolbar).getByText("열기")).toBeTruthy();
    expect(within(toolbar).getByText("이동")).toBeTruthy();
    expect(within(toolbar).queryByText("다운로드")).toBeNull();
    expect(within(toolbar).queryByText("발행")).toBeNull();
  });

  it("이미 발행된 파일을 선택하면 발행 대신 공개 링크와 발행취소가 나타난다", () => {
    renderList({
      selectedPath: "/a.txt",
      publishedLinks: {
        "/a.txt": { url: "http://public.test/x", publicPath: "abcd/a.txt" },
      },
    });

    const toolbar = screen.getByRole("toolbar");
    expect(within(toolbar).queryByText("발행")).toBeNull();
    expect(within(toolbar).getByText("발행 취소")).toBeTruthy();
    expect(screen.getByText("공개 링크")).toBeTruthy();
  });

  it("열기 버튼을 누르면 onOpenDirectory가 선택된 디렉터리로 호출된다", () => {
    const onOpenDirectory = vi.fn();
    renderList({
      items: [dirReports],
      selectedPath: "/reports",
      onOpenDirectory,
    });

    fireEvent.click(screen.getByText("열기"));

    expect(onOpenDirectory).toHaveBeenCalledWith(dirReports);
  });
});
