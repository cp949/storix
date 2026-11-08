import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import defaultSource, { createBaoSecretSource } from "../index.js";
import { startFakeBao } from "../test-support/fake-bao.mjs";

const KV = {
  "kv/example/storix": {
    db_password: "fake-db-pass",
    api_key: "fake-api-key",
    empty_value: "",
    number_value: 42,
    newline_value: "fake-with-newline\n",
  },
};
const 새어나가면_안_되는_값 = /fake-|secret-1|tok-1|db_password|api_key/;

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bao-adapter-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ref = (field) => `bao://kv/example/storix#${field}`;
const 신호 = () => ({ signal: new AbortController().signal });

async function 준비(
  t,
  { 파일내용 = "secret-1\n", bao: 옵션 = {}, env = {} } = {},
) {
  const bao = await startFakeBao({ kv: KV, ...옵션 });
  t.after(() => bao.close());
  const 파일 = join(dir, `sid-${Math.random().toString(36).slice(2)}`);
  if (파일내용 !== null) await writeFile(파일, 파일내용);
  const source = createBaoSecretSource({
    env: {
      BAO_ADDR: bao.addr,
      BAO_ROLE_ID: "role-1",
      BAO_SECRET_ID_FILE: 파일,
      ...env,
    },
  });
  return { bao, source, 파일 };
}

async function 오류종류(promise) {
  try {
    await promise;
  } catch (e) {
    assert.doesNotMatch(String(e.message), 새어나가면_안_되는_값);
    return e.kind;
  }
  return "성공";
}

test("기본 export는 scheme이 bao인 동결된 객체다", () => {
  assert.equal(defaultSource.scheme, "bao");
  assert.equal(typeof defaultSource.resolve, "function");
  assert.ok(Object.isFrozen(defaultSource));
});

test("필드 값을 돌려준다", async (t) => {
  const { source } = await 준비(t);
  assert.equal(
    await source.resolve(ref("db_password"), 신호()),
    "fake-db-pass",
  );
});

test("병렬로 5건을 읽어도 로그인은 한 번이다", async (t) => {
  const { source, bao } = await 준비(t);
  const 값들 = await Promise.all(
    ["db_password", "api_key", "db_password", "api_key", "db_password"].map(
      (f) => source.resolve(ref(f), 신호()),
    ),
  );
  assert.equal(값들.length, 5);
  assert.equal(bao.calls.login, 1);
  assert.equal(bao.calls.read, 5);
});

test("secret_id 파일의 끝 줄바꿈이 \\n, \\r\\n, 없음이어도 로그인한다", async (t) => {
  for (const 내용 of ["secret-1\n", "secret-1\r\n", "secret-1"]) {
    const { source } = await 준비(t, { 파일내용: 내용 });
    assert.equal(await source.resolve(ref("api_key"), 신호()), "fake-api-key");
  }
});

test("BAO_ADDR 끝의 슬래시를 무시한다", async (t) => {
  const { bao, 파일 } = await 준비(t);
  const 슬래시 = createBaoSecretSource({
    env: {
      BAO_ADDR: `${bao.addr}///`,
      BAO_ROLE_ID: "role-1",
      BAO_SECRET_ID_FILE: 파일,
    },
  });
  assert.equal(await 슬래시.resolve(ref("api_key"), 신호()), "fake-api-key");
});

test("저장된 값의 끝 줄바꿈을 그대로 돌려준다", async (t) => {
  const { source } = await 준비(t);
  assert.equal(
    await source.resolve(ref("newline_value"), 신호()),
    "fake-with-newline\n",
  );
});

test("잘못된 secret_id는 auth-failed다", async (t) => {
  const { source } = await 준비(t, { 파일내용: "틀린-secret-id" });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "auth-failed",
  );
});

test("로그인에 실패한 뒤 파일을 고치면 다시 로그인한다", async (t) => {
  const { source, 파일, bao } = await 준비(t, { 파일내용: "틀린-secret-id" });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "auth-failed",
  );
  await writeFile(파일, "secret-1\n");
  assert.equal(await source.resolve(ref("api_key"), 신호()), "fake-api-key");
  assert.equal(bao.calls.login, 2);
});

test("secret_id 파일이 없으면 auth-config다", async (t) => {
  const { source } = await 준비(t, { 파일내용: null });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "auth-config",
  );
});

test("BAO_ROLE_ID가 없으면 auth-config다", async (t) => {
  const { source } = await 준비(t, { env: { BAO_ROLE_ID: "" } });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "auth-config",
  );
});

test("BAO_ADDR가 없으면 config다", async (t) => {
  const { source } = await 준비(t, { env: { BAO_ADDR: "" } });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "config",
  );
});

test("지원하지 않는 로그인 방식은 auth-method다", async (t) => {
  for (const 방식 of ["cert", "constructor", "__proto__"]) {
    const { source } = await 준비(t, { env: { BAO_AUTH_METHOD: 방식 } });
    assert.equal(
      await 오류종류(source.resolve(ref("api_key"), 신호())),
      "auth-method",
    );
  }
});

test("없는 경로와 없는 필드는 not-found다", async (t) => {
  const { source } = await 준비(t);
  assert.equal(
    await 오류종류(source.resolve("bao://kv/example/nothing#api_key", 신호())),
    "not-found",
  );
  assert.equal(
    await 오류종류(source.resolve(ref("no_such_field"), 신호())),
    "not-found",
  );
});

test("참조 형식이 틀리면 서버를 호출하지 않고 invalid-ref다", async (t) => {
  const { source, bao } = await 준비(t);
  assert.equal(
    await 오류종류(source.resolve("bao://kv/a/../b#f", 신호())),
    "invalid-ref",
  );
  assert.equal(bao.calls.login + bao.calls.read, 0);
});

test("읽기 권한이 없으면 forbidden이다", async (t) => {
  const { source } = await 준비(t, { bao: { denyRead: true } });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "forbidden",
  );
});

test("문자열이 아니거나 빈 값은 bad-response다", async (t) => {
  const { source } = await 준비(t);
  assert.equal(
    await 오류종류(source.resolve(ref("empty_value"), 신호())),
    "bad-response",
  );
  assert.equal(
    await 오류종류(source.resolve(ref("number_value"), 신호())),
    "bad-response",
  );
});

test("로그인 응답이 JSON이 아니면 bad-response다", async (t) => {
  const { source } = await 준비(t, {
    bao: {
      loginRaw: { status: 502, body: "<html>bad gateway fake-db-pass</html>" },
    },
  });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "bad-response",
  );
});

test("읽기 응답이 JSON이 아니면 bad-response이고 내용을 옮기지 않는다", async (t) => {
  const { source } = await 준비(t, {
    bao: {
      readRaw: { status: 200, body: "<html>proxy page fake-api-key</html>" },
    },
  });
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "bad-response",
  );
});

test("서버에 접속할 수 없으면 network다", async (t) => {
  const { source, bao } = await 준비(t);
  await bao.close();
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), 신호())),
    "network",
  );
});

test("신호가 중단되면 aborted다", async (t) => {
  const { source } = await 준비(t, { bao: { loginDelayMs: 500 } });
  const 컨트롤러 = new AbortController();
  setTimeout(() => 컨트롤러.abort(), 20);
  assert.equal(
    await 오류종류(source.resolve(ref("api_key"), { signal: 컨트롤러.signal })),
    "aborted",
  );
});
