import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDocuments } from "../src/api/client";
import App from "../src/App";

vi.mock("./api/client", () => ({
  listDocuments: vi.fn(),
  searchDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  createDirectory: vi.fn(),
  moveEntry: vi.fn(),
  copyEntry: vi.fn(),
  removeEntry: vi.fn(),
  createDownload: vi.fn(),
  publishDocument: vi.fn(),
  unpublishDocument: vi.fn(),
}));

describe("App", () => {
  beforeEach(() => {
    vi.mocked(listDocuments).mockReset();
    vi.mocked(listDocuments).mockResolvedValue({ items: [], nextCursor: null });
  });

  it("기본 사용자는 alice이고, bob으로 전환하면 bob 기준으로 목록을 다시 불러온다", async () => {
    render(<App />);
    await waitFor(() =>
      expect(listDocuments).toHaveBeenCalledWith("alice", "/"),
    );

    fireEvent.change(screen.getByLabelText("사용자"), {
      target: { value: "bob" },
    });

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith("bob", "/"));
  });
});
