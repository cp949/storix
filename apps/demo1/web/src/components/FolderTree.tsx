import { useEffect, useRef, useState } from "react";
import { listDocuments } from "../api/client";
import type { DemoUser, FileEntry } from "../api/types";
import { useErrorReporter } from "../error/use-error-reporter";

export interface FolderTreeProps {
  readonly user: DemoUser;
  readonly selectedPath: string;
  readonly onNavigate: (path: string) => void;
  readonly refreshKey: number;
}

export function FolderTree({
  user,
  selectedPath,
  onNavigate,
  refreshKey,
}: FolderTreeProps) {
  return (
    <nav aria-label="폴더 트리">
      <TreeNode
        user={user}
        path="/"
        label="root"
        depth={0}
        selectedPath={selectedPath}
        onNavigate={onNavigate}
        refreshKey={refreshKey}
        defaultExpanded
      />
    </nav>
  );
}

interface TreeNodeProps {
  readonly user: DemoUser;
  readonly path: string;
  readonly label: string;
  readonly depth: number;
  readonly selectedPath: string;
  readonly onNavigate: (path: string) => void;
  readonly refreshKey: number;
  readonly defaultExpanded?: boolean;
}

function TreeNode({
  user,
  path,
  label,
  depth,
  selectedPath,
  onNavigate,
  refreshKey,
  defaultExpanded,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(Boolean(defaultExpanded));
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { reportError } = useErrorReporter();
  // 첫 페이지 재로드가 시작되면 올라가, 이전 요청의 "더 보기" 응답을 버리는 데 쓴다.
  const loadEpochRef = useRef(0);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    let cancelled = false;
    loadEpochRef.current += 1;
    listDocuments(user, path)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setChildren(result.items.filter((item) => item.type === "DIRECTORY"));
        setNextCursor(result.nextCursor);
      })
      .catch((cause) => {
        if (!cancelled) {
          reportError(cause);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadingMore(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, path, expanded, refreshKey, reportError]);

  // 폴더만 걸러 보여주므로 한 페이지에 폴더가 없어도 다음 페이지가 있을 수 있다.
  async function handleLoadMore() {
    if (nextCursor === null || loadingMore) {
      return;
    }
    const epoch = loadEpochRef.current;
    setLoadingMore(true);
    try {
      const result = await listDocuments(user, path, nextCursor);
      if (epoch !== loadEpochRef.current) {
        return;
      }
      setChildren((current) => [
        ...(current ?? []),
        ...result.items.filter((item) => item.type === "DIRECTORY"),
      ]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (epoch === loadEpochRef.current) {
        reportError(cause);
      }
    } finally {
      if (epoch === loadEpochRef.current) {
        setLoadingMore(false);
      }
    }
  }

  return (
    <div>
      <div style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          aria-label={`${label} ${expanded ? "접기" : "펼치기"}`}
          onClick={() => {
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            if (nextExpanded && children === null) {
              setLoading(true);
            }
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          aria-current={path === selectedPath ? "true" : undefined}
          onClick={() => onNavigate(path)}
        >
          📁 {label}
        </button>
      </div>
      {expanded &&
        (loading && children === null ? (
          <p style={{ paddingLeft: (depth + 1) * 12 }}>불러오는 중...</p>
        ) : (
          <>
            {(children ?? []).map((child) => (
              <TreeNode
                key={child.path}
                user={user}
                path={child.path}
                label={child.name}
                depth={depth + 1}
                selectedPath={selectedPath}
                onNavigate={onNavigate}
                refreshKey={refreshKey}
              />
            ))}
            {nextCursor !== null && (
              <div style={{ paddingLeft: (depth + 1) * 12 }}>
                <button
                  type="button"
                  aria-label={`${label} 더 보기`}
                  disabled={loadingMore}
                  onClick={() => void handleLoadMore()}
                >
                  더 보기
                </button>
              </div>
            )}
          </>
        ))}
    </div>
  );
}
