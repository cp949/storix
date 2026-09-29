import { useState } from "react";
import type { FileEntry, PublicLink } from "../api/types";

export interface EntryListProps {
  readonly items: FileEntry[];
  readonly selectedPath: string | null;
  readonly loading: boolean;
  readonly publishedLinks: Record<string, PublicLink>;
  readonly onSelect: (item: FileEntry) => void;
  readonly onOpenDirectory: (item: FileEntry) => void;
  readonly onMove: (item: FileEntry) => void;
  readonly onCopy: (item: FileEntry) => void;
  readonly onRemove: (item: FileEntry) => void;
  readonly onDownload: (item: FileEntry) => void;
  readonly onPublish: (item: FileEntry) => void;
  readonly onUnpublish: (item: FileEntry) => void;
  readonly onCopyLink: (url: string) => void;
  readonly onSetMimeType: (item: FileEntry, mimeType: string) => void;
}

export function EntryList({
  items,
  selectedPath,
  loading,
  publishedLinks,
  onSelect,
  onOpenDirectory,
  onMove,
  onCopy,
  onRemove,
  onDownload,
  onPublish,
  onUnpublish,
  onCopyLink,
  onSetMimeType,
}: EntryListProps) {
  const [editingMimeType, setEditingMimeType] = useState(false);
  const [mimeTypeDraft, setMimeTypeDraft] = useState("");
  const selectedItem = items.find((item) => item.path === selectedPath) ?? null;
  const publishedLink = selectedItem
    ? publishedLinks[selectedItem.path]
    : undefined;

  return (
    <div>
      {selectedItem && (
        <div role="toolbar" aria-label="선택 항목 작업">
          {selectedItem.type === "DIRECTORY" && (
            <button type="button" onClick={() => onOpenDirectory(selectedItem)}>
              열기
            </button>
          )}
          <button type="button" onClick={() => onMove(selectedItem)}>
            이동
          </button>
          <button type="button" onClick={() => onCopy(selectedItem)}>
            복사
          </button>
          <button type="button" onClick={() => onRemove(selectedItem)}>
            삭제
          </button>
          {selectedItem.type === "FILE" && (
            <button type="button" onClick={() => onDownload(selectedItem)}>
              다운로드
            </button>
          )}
          {selectedItem.type === "FILE" && (
            <button
              type="button"
              onClick={() => {
                setMimeTypeDraft(selectedItem.mimeType ?? "");
                setEditingMimeType(true);
              }}
            >
              MIME type 변경
            </button>
          )}
          {selectedItem.type === "FILE" &&
            (publishedLink ? (
              <button type="button" onClick={() => onUnpublish(selectedItem)}>
                발행 취소
              </button>
            ) : (
              <button type="button" onClick={() => onPublish(selectedItem)}>
                발행
              </button>
            ))}
        </div>
      )}

      {editingMimeType && selectedItem?.type === "FILE" && (
        <form
          aria-label="MIME type 수정"
          onSubmit={(event) => {
            event.preventDefault();
            onSetMimeType(selectedItem, mimeTypeDraft);
            setEditingMimeType(false);
          }}
        >
          <label>
            MIME type
            <input
              value={mimeTypeDraft}
              onChange={(event) => setMimeTypeDraft(event.target.value)}
              required
            />
          </label>
          <button type="submit">저장</button>
          <button type="button" onClick={() => setEditingMimeType(false)}>
            취소
          </button>
        </form>
      )}

      {publishedLink && (
        <p>
          <a href={publishedLink.url} target="_blank" rel="noreferrer">
            공개 링크
          </a>
          <button type="button" onClick={() => onCopyLink(publishedLink.url)}>
            링크 복사
          </button>
        </p>
      )}

      {loading ? (
        <p>불러오는 중...</p>
      ) : items.length === 0 ? (
        <p>이 폴더는 비어 있습니다.</p>
      ) : (
        <table aria-label="문서 목록">
          <thead>
            <tr>
              <th>이름</th>
              <th>유형</th>
              <th>MIME type</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.path}
                aria-selected={item.path === selectedPath}
                onClick={() => {
                  setEditingMimeType(false);
                  onSelect(item);
                }}
              >
                <td>
                  {item.type === "DIRECTORY" ? "📁" : "📄"} {item.name}
                </td>
                <td>{item.type === "DIRECTORY" ? "폴더" : "파일"}</td>
                <td>{item.mimeType ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
