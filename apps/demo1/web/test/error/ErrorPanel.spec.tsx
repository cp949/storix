import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { ErrorProvider } from "../../src/error/ErrorProvider";
import { useErrorReporter } from "../../src/error/use-error-reporter";
import { ErrorPanel } from "../../src/error/ErrorPanel";

function Trigger() {
  const { reportError } = useErrorReporter();
  return (
    <button
      type="button"
      onClick={() =>
        reportError(
          new ApiError(403, "DOCUMENT_PATH_ESCAPES_ROOT", "req-1", "경로 이탈"),
        )
      }
    >
      트리거
    </button>
  );
}

describe("ErrorPanel", () => {
  it("오류가 없으면 아무것도 렌더링하지 않는다", () => {
    render(
      <ErrorProvider>
        <ErrorPanel />
      </ErrorProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reportError가 호출되면 상태 코드·에러 코드·requestId를 보여준다", () => {
    render(
      <ErrorProvider>
        <Trigger />
        <ErrorPanel />
      </ErrorProvider>,
    );

    fireEvent.click(screen.getByText("트리거"));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("403");
    expect(alert.textContent).toContain("DOCUMENT_PATH_ESCAPES_ROOT");
    expect(alert.textContent).toContain("req-1");
  });

  it("닫기 버튼을 누르면 패널이 사라진다", () => {
    render(
      <ErrorProvider>
        <Trigger />
        <ErrorPanel />
      </ErrorProvider>,
    );

    fireEvent.click(screen.getByText("트리거"));
    fireEvent.click(screen.getByText("닫기"));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
