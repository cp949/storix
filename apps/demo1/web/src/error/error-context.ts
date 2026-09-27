import { createContext } from "react";

export interface DisplayedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

export interface ErrorContextValue {
  readonly error: DisplayedError | null;
  readonly reportError: (cause: unknown) => void;
  readonly clearError: () => void;
}

export const ErrorContext = createContext<ErrorContextValue | null>(null);
