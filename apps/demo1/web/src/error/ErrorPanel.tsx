import { useErrorReporter } from './ErrorContext';

export function ErrorPanel() {
  const { error, clearError } = useErrorReporter();

  if (!error) {
    return null;
  }

  return (
    <div role="alert" className="error-panel">
      <strong>
        {error.status} {error.code}
      </strong>
      <p>{error.message}</p>
      {error.requestId && <p>requestId: {error.requestId}</p>}
      <button type="button" onClick={clearError}>
        닫기
      </button>
    </div>
  );
}
