import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { ErrorContext, type DisplayedError } from "./error-context";

export function ErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<DisplayedError | null>(null);

  const reportError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError) {
      setError({
        status: cause.status,
        code: cause.code,
        message: cause.message,
        requestId: cause.requestId,
      });
      return;
    }
    setError({
      status: 0,
      code: "CLIENT_ERROR",
      message: cause instanceof Error ? cause.message : String(cause),
      requestId: "",
    });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(
    () => ({ error, reportError, clearError }),
    [error, reportError, clearError],
  );

  return (
    <ErrorContext.Provider value={value}>{children}</ErrorContext.Provider>
  );
}
