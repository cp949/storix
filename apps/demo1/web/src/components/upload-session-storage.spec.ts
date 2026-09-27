import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeExternalPath,
  readUploadSession,
  saveUploadSession,
  uploadSessionStorageKey,
} from "./upload-session-storage";

describe("uploadSessionStorageKey", () => {
  beforeEach(() => localStorage.clear());

  it("사용자, 정규화 내부 경로, 크기, lastModified가 다르면 세션 참조가 분리된다", () => {
    const base = new File(["abc"], "large.bin", { lastModified: 10 });
    const changed = new File(["abc"], "large.bin", { lastModified: 11 });
    const bigger = new File(["abcd"], "large.bin", { lastModified: 10 });
    const key = uploadSessionStorageKey("alice", "/large.bin", base);
    saveUploadSession(key, {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });

    expect(uploadSessionStorageKey("alice", "//large.bin", base)).toBe(key);
    expect(uploadSessionStorageKey("alice", "/large.bin ", base)).toBe(key);
    expect(
      readUploadSession(uploadSessionStorageKey("bob", "/large.bin", base)),
    ).toBeNull();
    expect(
      readUploadSession(
        uploadSessionStorageKey("alice", "/other/large.bin", base),
      ),
    ).toBeNull();
    expect(
      readUploadSession(
        uploadSessionStorageKey("alice", "/large.bin", changed),
      ),
    ).toBeNull();
    expect(
      readUploadSession(uploadSessionStorageKey("alice", "/large.bin", bigger)),
    ).toBeNull();
  });

  it("분해형 유니코드 파일명을 Storix 정규 경로와 같은 NFC 경로로 맞춘다", () => {
    const decomposedName = "cafe\u0301.bin";
    const composedName = "café.bin";
    const file = new File(["abc"], decomposedName, { lastModified: 10 });

    expect(normalizeExternalPath(`/${decomposedName}`)).toBe(
      `/${composedName}`,
    );
    expect(uploadSessionStorageKey("alice", `/${decomposedName}`, file)).toBe(
      uploadSessionStorageKey("alice", `/${composedName}`, file),
    );
  });
});
