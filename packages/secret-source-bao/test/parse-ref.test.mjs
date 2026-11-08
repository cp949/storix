import assert from "node:assert/strict";
import { test } from "node:test";
import { BaoError } from "../src/errors.js";
import { parseRef } from "../src/parse-ref.js";

test("마운트, 경로, 필드를 나눈다", () => {
  assert.deepEqual(parseRef("bao://kv/example/storix#db_password"), {
    mount: "kv",
    path: "example/storix",
    field: "db_password",
  });
});

test("경로가 한 단계여도 받는다", () => {
  assert.deepEqual(parseRef("bao://kv/storix#api_key"), {
    mount: "kv",
    path: "storix",
    field: "api_key",
  });
});

test("이름 안의 점과 하이픈을 받는다", () => {
  assert.deepEqual(parseRef("bao://kv/a.b/c-d#f.g-h"), {
    mount: "kv",
    path: "a.b/c-d",
    field: "f.g-h",
  });
});

const 거부할_참조 = [
  ["scheme이 다르다", "aws-sm://kv/a#b"],
  ["scheme만 있다", "bao://"],
  ["필드 구분자가 없다", "bao://kv/a/b"],
  ["필드가 비었다", "bao://kv/a/b#"],
  ["마운트만 있다", "bao://kv#f"],
  ["마운트 뒤 경로가 비었다", "bao://kv/#f"],
  ["상위 경로 이동", "bao://kv/a/../b#f"],
  ["현재 경로 구성 요소", "bao://kv/a/./b#f"],
  ["빈 경로 구성 요소", "bao://kv/a//b#f"],
  ["공백이 있다", "bao://kv/a b#f"],
  ["쿼리 문자가 있다", "bao://kv/a?x=1#f"],
  ["필드에 슬래시가 있다", "bao://kv/a#f/g"],
  ["필드 구분자가 두 개다", "bao://kv/a#f#g"],
  ["문자열이 아니다", undefined],
];

for (const [이유, 참조] of 거부할_참조) {
  test(`거부한다: ${이유}`, () => {
    assert.throws(
      () => parseRef(참조),
      (e) => e instanceof BaoError && e.kind === "invalid-ref",
    );
  });
}
