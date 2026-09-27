import { useContext } from "react";
import { ErrorContext } from "./error-context";

export function useErrorReporter() {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error(
      "useErrorReporter는 ErrorProvider 내부에서만 사용할 수 있다",
    );
  }
  return context;
}
