import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  copyEntry,
  createDirectory,
  listDocuments,
  moveEntry,
  removeEntry,
  searchDocuments,
  uploadDocument,
  createDownload,
  publishDocument,
  unpublishDocument,
} from "../api/client";
import type { DemoUser, FileEntry, PublicLink } from "../api/types";
import { useErrorReporter } from "../error/ErrorContext";
import { joinPath } from "../utils/path";
import { EntryList } from "./EntryList";
import { FolderTree } from "./FolderTree";
import { ResumableUpload } from "./ResumableUpload";

export interface DocumentArchiveProps {
  readonly user: DemoUser;
}

function splitBreadcrumb(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function DocumentArchive({ user }: DocumentArchiveProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchName, setSearchName] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "uploading" | "success" | "error"
  >("idle");
  const [newFolderName, setNewFolderName] = useState("");
  const [publishedLinks, setPublishedLinks] = useState<
    Record<string, PublicLink>
  >({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const { reportError, clearError } = useErrorReporter();

  const loadList = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        const pageResult = await listDocuments(user, path);
        setItems(pageResult.items);
        clearError();
      } catch (cause) {
        reportError(cause);
      } finally {
        setLoading(false);
      }
    },
    [user, reportError, clearError],
  );

  useEffect(() => {
    setCurrentPath("/");
  }, [user]);

  useEffect(() => {
    setSearchResults(null);
    setSelectedPath(null);
    void loadList(currentPath);
  }, [currentPath, loadList]);

  async function handleSearch() {
    setLoading(true);
    try {
      const pageResult = await searchDocuments(user, "/", searchName);
      setSearchResults(pageResult.items);
      setSelectedPath(null);
      clearError();
    } catch (cause) {
      reportError(cause);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(file: File) {
    setUploadStatus("uploading");
    try {
      await uploadDocument(user, joinPath(currentPath, file.name), file);
      setUploadStatus("success");
      clearError();
      await loadList(currentPath);
    } catch (cause) {
      setUploadStatus("error");
      reportError(cause);
    }
  }

  async function handleCreateDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) {
      return;
    }
    try {
      await createDirectory(user, joinPath(currentPath, name));
      setNewFolderName("");
      clearError();
      setTreeRefreshKey((key) => key + 1);
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleMove(item: FileEntry) {
    const destination = window.prompt("이동할 대상 경로", item.path);
    if (!destination) {
      return;
    }
    try {
      await moveEntry(user, item.path, destination);
      clearError();
      setSelectedPath(null);
      setTreeRefreshKey((key) => key + 1);
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleCopy(item: FileEntry) {
    const destination = window.prompt("복사할 대상 경로", item.path);
    if (!destination) {
      return;
    }
    try {
      await copyEntry(user, item.path, destination);
      clearError();
      setSelectedPath(null);
      setTreeRefreshKey((key) => key + 1);
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleRemove(item: FileEntry) {
    if (!window.confirm(`${item.name}을(를) 삭제할까요?`)) {
      return;
    }
    try {
      await removeEntry(user, item.path, item.type === "DIRECTORY");
      clearError();
      setSelectedPath(null);
      setTreeRefreshKey((key) => key + 1);
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleDownload(item: FileEntry) {
    try {
      const download = await createDownload(user, item.path);
      window.open(download.url, "_blank");
      clearError();
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handlePublish(item: FileEntry) {
    if (
      !window.confirm(
        "공개 발행은 되돌릴 수 없습니다(발행 취소해도 이미 공유된 링크는 회수되지 않습니다). 계속할까요?",
      )
    ) {
      return;
    }
    try {
      const link = await publishDocument(user, item.path);
      setPublishedLinks((prev) => ({ ...prev, [item.path]: link }));
      clearError();
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleUnpublish(item: FileEntry) {
    try {
      await unpublishDocument(user, item.path);
      setPublishedLinks((prev) => {
        const next = { ...prev };
        delete next[item.path];
        return next;
      });
      clearError();
    } catch (cause) {
      reportError(cause);
    }
  }

  function copyToClipboard(url: string) {
    void navigator.clipboard?.writeText(url);
  }

  const breadcrumbSegments = splitBreadcrumb(currentPath);
  const visibleItems = searchResults ?? items;

  return (
    <section aria-label="문서 아카이브" className="archive-layout">
      <aside className="archive-sidebar">
        <FolderTree
          user={user}
          selectedPath={currentPath}
          onNavigate={setCurrentPath}
          refreshKey={treeRefreshKey}
        />
      </aside>

      <div className="archive-main">
        <nav aria-label="현재 위치">
          <button type="button" onClick={() => setCurrentPath("/")}>
            root
          </button>
          {breadcrumbSegments.map((segment, index) => {
            const path = `/${breadcrumbSegments.slice(0, index + 1).join("/")}`;
            return (
              <span key={path}>
                {" / "}
                <button type="button" onClick={() => setCurrentPath(path)}>
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="archive-toolbar">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSearch();
            }}
          >
            <label>
              검색어
              <input
                value={searchName}
                onChange={(event) => setSearchName(event.target.value)}
              />
            </label>
            <button type="submit">검색</button>
            {searchResults !== null && (
              <button type="button" onClick={() => setSearchResults(null)}>
                목록으로 돌아가기
              </button>
            )}
            <p className="archive-hint">
              검색은 항상 전체 폴더를 대상으로 합니다.
            </p>
          </form>

          <div
            className="archive-upload"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file) {
                void handleUpload(file);
              }
            }}
          >
            <label>
              파일 업로드
              <input
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleUpload(file);
                  }
                  event.target.value = "";
                }}
              />
            </label>
            <p role="status">
              {uploadStatus === "uploading" && "업로드중..."}
              {uploadStatus === "success" && "업로드 완료"}
              {uploadStatus === "error" && "업로드 실패"}
            </p>
          </div>

          <ResumableUpload
            key={`${user}:${currentPath}`}
            user={user}
            currentPath={currentPath}
            onComplete={async () => {
              setSearchResults(null);
              setTreeRefreshKey((key) => key + 1);
              await loadList(currentPath);
            }}
          />

          <form onSubmit={handleCreateDirectory}>
            <label>
              새 폴더 이름
              <input
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
              />
            </label>
            <button type="submit">폴더 만들기</button>
          </form>
        </div>

        <EntryList
          items={visibleItems}
          selectedPath={selectedPath}
          loading={loading}
          publishedLinks={publishedLinks}
          onSelect={(item) => setSelectedPath(item.path)}
          onOpenDirectory={(item) => setCurrentPath(item.path)}
          onMove={handleMove}
          onCopy={handleCopy}
          onRemove={handleRemove}
          onDownload={handleDownload}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          onCopyLink={copyToClipboard}
        />
      </div>
    </section>
  );
}
