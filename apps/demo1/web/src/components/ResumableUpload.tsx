import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  putUploadSessionPart,
} from "../api/client";
import type { DemoUser, UploadSessionStatus } from "../api/types";
import { useErrorReporter } from "../error/use-error-reporter";
import { joinPath } from "../utils/path";
import {
  clearUploadSession,
  normalizeExternalPath,
  readUploadSession,
  saveUploadSession,
  uploadSessionStorageKey,
} from "./upload-session-storage";

interface ResumableUploadProps {
  readonly user: DemoUser;
  readonly currentPath: string;
  readonly onComplete: () => Promise<void>;
}

type UploadState = "idle" | "uploading" | "paused" | "success" | "error";
type CancelOutcome =
  | {
      readonly kind:
        "cancelled" | "unavailable" | "completed" | "finalizing" | "open";
    }
  | { readonly kind: "failed"; readonly cause: unknown };

function clearsReference(outcome: CancelOutcome): boolean {
  return (
    outcome.kind === "cancelled" ||
    outcome.kind === "unavailable" ||
    outcome.kind === "completed"
  );
}

function matchesFile(
  status: UploadSessionStatus,
  path: string,
  file: File,
): boolean {
  return (
    status.path === path &&
    status.sizeBytes === String(file.size) &&
    status.mimeType === (file.type || "application/octet-stream") &&
    Number.isSafeInteger(status.partSizeBytes) &&
    status.partSizeBytes > 0 &&
    status.partCount === Math.ceil(file.size / status.partSizeBytes)
  );
}

function sessionMissingOrExpired(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    (cause.status === 404 || cause.code === "VFS_UPLOAD_SESSION_EXPIRED")
  );
}

export function ResumableUpload({
  user,
  currentPath,
  onComplete,
}: ResumableUploadProps) {
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState({ uploaded: 0, total: 0 });
  const [message, setMessage] = useState("");
  const [activeSession, setActiveSession] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const selectedKey = useRef<string | null>(null);
  const cancelInFlight = useRef<{
    key: string;
    id: string;
    promise: Promise<CancelOutcome>;
  } | null>(null);
  const { clearError, reportError } = useErrorReporter();

  useEffect(
    () => () => {
      run.current += 1;
      abort.current?.abort();
    },
    [],
  );

  async function start(file: File) {
    const currentRun = ++run.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const isCurrent = () =>
      run.current === currentRun && !controller.signal.aborted;
    let key: string | null = null;
    selectedKey.current = null;
    setActiveSession(null);
    setCancelling(false);
    setProgress({ uploaded: 0, total: 0 });
    setMessage("");
    setState("uploading");
    clearError();

    try {
      const path = normalizeExternalPath(joinPath(currentPath, file.name));
      key = uploadSessionStorageKey(user, path, file);
      selectedKey.current = key;
      const pendingCancel = cancelInFlight.current;
      if (pendingCancel?.key === key) {
        const outcome = await pendingCancel.promise;
        if (!isCurrent()) return;
        if (
          clearsReference(outcome) &&
          readUploadSession(key)?.sessionId === pendingCancel.id
        ) {
          clearUploadSession(key);
        }
        if (outcome.kind === "completed") {
          setActiveSession(null);
          selectedKey.current = null;
          await onComplete();
          if (isCurrent()) setState("success");
          return;
        }
      }
      let stored = readUploadSession(key);
      if (!stored) {
        stored = { idempotencyKey: crypto.randomUUID() };
        saveUploadSession(key, stored);
      }

      let sessionId = stored.sessionId;
      if (!sessionId) {
        const created = await createUploadSession(
          user,
          path,
          file,
          stored.idempotencyKey,
          controller.signal,
        );
        if (!isCurrent()) return;
        sessionId = created.sessionId;
        saveUploadSession(key, { ...stored, sessionId });
      }
      setActiveSession({ key, id: sessionId });

      const session = await getUploadSession(
        user,
        sessionId,
        controller.signal,
      );
      if (!isCurrent()) return;
      if (!matchesFile(session, path, file)) {
        clearUploadSession(key);
        setActiveSession(null);
        setMessage(
          "저장된 세션과 선택한 파일이 일치하지 않습니다. 같은 파일을 다시 선택해 새로 시작하세요.",
        );
        setState("error");
        return;
      }
      if (session.state === "COMPLETED") {
        clearUploadSession(key);
        setActiveSession(null);
        selectedKey.current = null;
        await onComplete();
        if (isCurrent()) setState("success");
        return;
      }
      if (session.state !== "OPEN") {
        if (session.state !== "FINALIZING") {
          clearUploadSession(key);
          setActiveSession(null);
        }
        setMessage(
          session.state === "FINALIZING"
            ? "서버에서 업로드를 마무리하고 있습니다. 잠시 뒤 같은 파일을 다시 선택하세요."
            : "세션이 만료되었거나 종료되었습니다. 같은 파일을 다시 선택해 새로 시작하세요.",
        );
        setState("error");
        return;
      }

      const uploaded = new Set(session.parts.map((part) => part.index));
      setProgress({ uploaded: uploaded.size, total: session.partCount });
      for (let index = 0; index < session.partCount; index += 1) {
        if (!isCurrent()) return;
        if (uploaded.has(index)) continue;
        const offset = index * session.partSizeBytes;
        const part = file.slice(
          offset,
          Math.min(file.size, offset + session.partSizeBytes),
        );
        await putUploadSessionPart(
          user,
          sessionId,
          index,
          part,
          controller.signal,
        );
        if (!isCurrent()) return;
        uploaded.add(index);
        setProgress({ uploaded: uploaded.size, total: session.partCount });
      }
      await completeUploadSession(user, sessionId, controller.signal);
      if (!isCurrent()) return;
      clearUploadSession(key);
      setActiveSession(null);
      selectedKey.current = null;
      await onComplete();
      if (isCurrent()) setState("success");
    } catch (cause) {
      if (!isCurrent()) return;
      if (key && sessionMissingOrExpired(cause)) {
        clearUploadSession(key);
        setActiveSession(null);
        setMessage(
          "세션이 만료되었거나 없어졌습니다. 같은 파일을 다시 선택해 새로 시작하세요.",
        );
      } else if (
        cause instanceof ApiError &&
        cause.code === "VFS_UPLOAD_SESSION_CLOSED"
      ) {
        setMessage(
          "서버에서 세션을 마무리하고 있을 수 있습니다. 잠시 뒤 같은 파일을 다시 선택해 상태를 확인하세요.",
        );
      } else {
        setMessage(
          "같은 파일을 다시 선택하면 서버에 저장된 조각부터 이어서 업로드합니다.",
        );
      }
      setState("error");
      reportError(cause);
    }
  }

  function stop() {
    run.current += 1;
    abort.current?.abort();
    setState("paused");
    setMessage(
      "업로드를 중단했습니다. 같은 파일을 다시 선택하면 이어서 업로드합니다.",
    );
  }

  async function cancel() {
    if (!activeSession || cancelInFlight.current) return;
    const target = activeSession;
    const cancellationRun = ++run.current;
    abort.current?.abort();
    setCancelling(true);
    setMessage("세션 취소 중...");
    const promise: Promise<CancelOutcome> = cancelUploadSession(user, target.id)
      .then(() => ({ kind: "cancelled" as const }))
      .catch(async (cause: unknown): Promise<CancelOutcome> => {
        if (
          cause instanceof ApiError &&
          cause.code === "VFS_UPLOAD_SESSION_CLOSED"
        ) {
          try {
            const session = await getUploadSession(user, target.id);
            if (session.state === "COMPLETED") return { kind: "completed" };
            if (session.state === "FINALIZING") return { kind: "finalizing" };
            if (session.state === "OPEN") return { kind: "open" };
            return { kind: "unavailable" };
          } catch (statusCause) {
            return sessionMissingOrExpired(statusCause)
              ? { kind: "unavailable" }
              : { kind: "failed", cause: statusCause };
          }
        }
        return sessionMissingOrExpired(cause)
          ? { kind: "unavailable" }
          : { kind: "failed", cause };
      });
    const pending = { key: target.key, id: target.id, promise };
    cancelInFlight.current = pending;
    const outcome = await promise;
    if (cancelInFlight.current === pending) cancelInFlight.current = null;
    if (
      clearsReference(outcome) &&
      readUploadSession(target.key)?.sessionId === target.id
    ) {
      clearUploadSession(target.key);
    }
    if (run.current !== cancellationRun || selectedKey.current !== target.key)
      return;
    setCancelling(false);
    if (outcome.kind === "completed") {
      setActiveSession(null);
      selectedKey.current = null;
      setMessage("");
      clearError();
      await onComplete();
      if (run.current === cancellationRun) setState("success");
      return;
    }
    if (outcome.kind === "finalizing" || outcome.kind === "open") {
      setState("paused");
      setMessage(
        outcome.kind === "finalizing"
          ? "서버에서 업로드를 마무리하고 있습니다. 잠시 뒤 같은 파일을 다시 선택해 상태를 확인하세요."
          : "세션이 아직 열려 있습니다. 같은 파일을 다시 선택하거나 취소를 다시 시도하세요.",
      );
      return;
    }
    if (outcome.kind !== "failed") {
      setActiveSession(null);
      selectedKey.current = null;
      setProgress({ uploaded: 0, total: 0 });
      setState(outcome.kind === "cancelled" ? "idle" : "error");
      setMessage(
        outcome.kind === "cancelled"
          ? "세션을 취소했습니다."
          : "세션이 이미 종료되었습니다. 같은 파일을 다시 선택해 새로 시작하세요.",
      );
      clearError();
      return;
    }
    setMessage(
      "세션 취소에 실패했습니다. 같은 파일을 다시 선택해 다시 시도하세요.",
    );
    setState("error");
    reportError(outcome.cause);
  }

  return (
    <div className="archive-upload">
      <label>
        재개 업로드 파일
        <input
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void start(file);
            event.target.value = "";
          }}
        />
      </label>
      <p className="archive-hint">
        브라우저를 다시 열거나 업로드가 중단되면 같은 파일을 다시 선택해야
        이어집니다.
      </p>
      <p role="status">
        {state === "uploading" &&
          `재개 업로드중... (${progress.uploaded}/${progress.total} 조각)`}
        {state === "paused" && "재개 업로드 중단"}
        {state === "success" && "재개 업로드 완료"}
        {state === "error" && "재개 업로드 실패"}
      </p>
      {message && <p className="archive-hint">{message}</p>}
      <div className="archive-upload-actions">
        {state === "uploading" && (
          <button type="button" onClick={stop}>
            중단
          </button>
        )}
        {activeSession && (
          <button
            type="button"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            세션 취소
          </button>
        )}
      </div>
    </div>
  );
}
