import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';

export interface DisplayedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

interface ErrorContextValue {
  readonly error: DisplayedError | null;
  readonly reportError: (cause: unknown) => void;
  readonly clearError: () => void;
}

const ErrorContext = createContext<ErrorContextValue | null>(null);

export function ErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<DisplayedError | null>(null);

  const reportError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError) {
      setError({ status: cause.status, code: cause.code, message: cause.message, requestId: cause.requestId });
      return;
    }
    setError({
      status: 0,
      code: 'CLIENT_ERROR',
      message: cause instanceof Error ? cause.message : String(cause),
      requestId: '',
    });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(() => ({ error, reportError, clearError }), [error, reportError, clearError]);

  return <ErrorContext.Provider value={value}>{children}</ErrorContext.Provider>;
}

export function useErrorReporter(): ErrorContextValue {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error('useErrorReporter는 ErrorProvider 내부에서만 사용할 수 있다');
  }
  return context;
}
