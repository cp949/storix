/**
 * AWS Secrets Manager 어댑터를 로컬 HTTP fixture와 node:test로 검증한다.
 * 어댑터 계약은 docs/design/15-secret-sources.md "어댑터 계약"을 따른다.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, test } from "node:test";

const previousEnvironment = new Map();
let server;
let endpoint;
let requests;

beforeEach(async () => {
  for (const name of [
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "STORIX_AWS_SM_ENDPOINT",
  ]) {
    previousEnvironment.set(name, process.env[name]);
  }
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  requests = [];
});

afterEach(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  server = undefined;
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousEnvironment.clear();
});

/** 로컬 AWS 호환 API fixture를 시작한다. */
async function startFixture(handler) {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsedBody = JSON.parse(body);
    requests.push({
      target: request.headers["x-amz-target"],
      body: parsedBody,
    });
    handler(request, response, parsedBody);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  endpoint = `http://127.0.0.1:${server.address().port}`;
  process.env.STORIX_AWS_SM_ENDPOINT = endpoint;
}

/** AWS 호환 응답을 fixture 요청자에게 반환한다. */
function respond(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/x-amz-json-1.1",
    "x-amzn-requestid": "fixture-request",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

/** 어댑터의 기본 export를 불러온다. */
async function loadAdapter() {
  return (await import("../index.js")).default;
}

test("이름과 ARN에서 scheme 접두어만 제거해 SecretId로 보낸다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: "test-api-key" }),
  );
  const adapter = await loadAdapter();

  assert.equal(
    await adapter.resolve("aws-sm://storix/localstack/api-key", {
      signal: new AbortController().signal,
    }),
    "test-api-key",
  );
  assert.equal(requests[0].target, "secretsmanager.GetSecretValue");
  assert.equal(requests[0].body.SecretId, "storix/localstack/api-key");

  const arn =
    "aws-sm://arn:aws:secretsmanager:us-east-1:123456789012:secret:team/api-key-AbCdEf";
  assert.equal(
    await adapter.resolve(arn, { signal: new AbortController().signal }),
    "test-api-key",
  );
  assert.equal(requests[1].body.SecretId, arn.slice("aws-sm://".length));
});

test("SecretString의 공백과 줄바꿈을 그대로 반환한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: "  key\n" }),
  );
  const adapter = await loadAdapter();

  assert.equal(
    await adapter.resolve("aws-sm://secret", {
      signal: new AbortController().signal,
    }),
    "  key\n",
  );
});

test("SecretBinary 응답은 거부한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, {
      SecretBinary: Buffer.from("key").toString("base64"),
    }),
  );
  const adapter = await loadAdapter();

  await assert.rejects(
    adapter.resolve("aws-sm://secret", {
      signal: new AbortController().signal,
    }),
  );
});

test("SecretString 필드가 없는 응답은 거부한다", async () => {
  await startFixture((_request, response) => respond(response, 200, {}));
  const adapter = await loadAdapter();

  await assert.rejects(
    adapter.resolve("aws-sm://secret", {
      signal: new AbortController().signal,
    }),
  );
});

test("AccessDeniedException의 SDK 오류를 그대로 상위로 전달한다", async () => {
  await startFixture((_request, response) =>
    respond(
      response,
      400,
      { message: "denied" },
      { "x-amzn-errortype": "AccessDeniedException:http://internal" },
    ),
  );
  const adapter = await loadAdapter();

  await assert.rejects(
    adapter.resolve("aws-sm://secret", {
      signal: new AbortController().signal,
    }),
  );
});

test("이미 중단된 signal로는 요청을 보내지 않는다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: "unused" }),
  );
  const adapter = await loadAdapter();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    adapter.resolve("aws-sm://secret", { signal: controller.signal }),
  );
  assert.equal(requests.length, 0);
});

test("진행 중 요청을 중단하면 HTTP 연결을 닫는다", async () => {
  let connectionClosed;
  const closed = new Promise((resolve) => (connectionClosed = resolve));
  await startFixture((_request, response) => {
    response.on("close", connectionClosed);
    response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
  });
  const adapter = await loadAdapter();
  const controller = new AbortController();
  const result = adapter.resolve("aws-sm://secret", {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();

  await assert.rejects(result);
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("HTTP 연결이 닫히지 않음")), 1000),
    ),
  ]);
});

test("요청별 client로 병렬 조회 결과를 분리한다", async () => {
  await startFixture((_request, response, body) => {
    const delay = body.SecretId === "first" ? 40 : 5;
    setTimeout(
      () => respond(response, 200, { SecretString: `${body.SecretId}-value` }),
      delay,
    );
  });
  const adapter = await loadAdapter();

  const [first, second] = await Promise.all([
    adapter.resolve("aws-sm://first", { signal: new AbortController().signal }),
    adapter.resolve("aws-sm://second", {
      signal: new AbortController().signal,
    }),
  ]);
  assert.deepEqual([first, second], ["first-value", "second-value"]);
});

test("AWS_REGION이 없으면 SDK 호출 전에 거부한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: "unused" }),
  );
  delete process.env.AWS_REGION;
  const adapter = await loadAdapter();

  await assert.rejects(
    adapter.resolve("aws-sm://secret", {
      signal: new AbortController().signal,
    }),
  );
  assert.equal(requests.length, 0);
});

test("알 수 없는 scheme 접두어를 거부한다", async () => {
  const adapter = await loadAdapter();

  await assert.rejects(
    adapter.resolve("other://secret", { signal: new AbortController().signal }),
  );
});

const JSON_SECRET = JSON.stringify({
  "db-password": "db-pass-value",
  "api.key": "api-key-value",
  api_key2: "api-key2-value",
  "admin-api-key": "  admin\n",
  count: 3,
  flag: true,
  nothing: null,
  nested: { a: "x" },
  empty: "",
});

/** 참조를 해석하고 거부 오류를 돌려준다. */
async function rejectionOf(ref) {
  const adapter = await loadAdapter();
  try {
    await adapter.resolve(ref, { signal: new AbortController().signal });
  } catch (error) {
    return error;
  }
  assert.fail("거부되어야 한다");
}

test("# 뒤 키로 JSON 시크릿의 문자열 값만 반환한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );
  const adapter = await loadAdapter();
  const signal = new AbortController().signal;

  assert.equal(
    await adapter.resolve("aws-sm://ttmo-prd/storix#db-password", { signal }),
    "db-pass-value",
  );
  assert.equal(
    await adapter.resolve("aws-sm://ttmo-prd/storix#api.key", { signal }),
    "api-key-value",
  );
  assert.equal(
    await adapter.resolve("aws-sm://ttmo-prd/storix#api_key2", { signal }),
    "api-key2-value",
  );
  // 코어는 값을 그대로 쓰므로 공백과 줄바꿈을 바꾸지 않는다.
  assert.equal(
    await adapter.resolve("aws-sm://ttmo-prd/storix#admin-api-key", { signal }),
    "  admin\n",
  );
  assert.equal(
    await adapter.resolve("aws-sm://ttmo-prd/storix#empty", { signal }),
    "",
  );
});

test("키를 붙여도 SecretId에는 # 앞부분만 보낸다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );
  const adapter = await loadAdapter();
  const arn =
    "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ttmo-prd/storix-AbCdEf";

  await adapter.resolve(`aws-sm://${arn}#db-password`, {
    signal: new AbortController().signal,
  });
  assert.equal(requests[0].body.SecretId, arn);
});

test("키가 없는 참조는 JSON이어도 SecretString 전체를 반환한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );
  const adapter = await loadAdapter();

  assert.equal(
    await adapter.resolve("aws-sm://ttmo-prd/storix", {
      signal: new AbortController().signal,
    }),
    JSON_SECRET,
  );
});

test("JSON에 없는 키는 키 이름만 담아 거부한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );

  const error = await rejectionOf("aws-sm://ttmo-prd/storix#missing");
  assert.match(error.message, /missing/);
  assert.doesNotMatch(error.message, /db-pass-value/);
});

test("Object.prototype 속성 이름은 키로 인정하지 않는다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );

  for (const key of ["__proto__", "constructor", "toString"]) {
    const error = await rejectionOf(`aws-sm://ttmo-prd/storix#${key}`);
    // 값 형식 검사가 아니라 키 존재 검사로 거부되어야 한다.
    assert.match(error.message, /키가 없습니다/);
  }
});

test("문자열이 아닌 값은 변환하지 않고 거부한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );

  for (const key of ["count", "flag", "nothing", "nested"]) {
    const error = await rejectionOf(`aws-sm://ttmo-prd/storix#${key}`);
    assert.match(error.message, new RegExp(key));
  }
});

test("JSON 객체가 아닌 SecretString은 내용을 노출하지 않고 거부한다", async () => {
  for (const secret of [
    "plain-secret-value",
    '["leak-array-value"]',
    "null",
    '"leak-string-value"',
    "12345",
    '{"db-password": "leak-broken',
  ]) {
    await startFixture((_request, response) =>
      respond(response, 200, { SecretString: secret }),
    );
    const error = await rejectionOf("aws-sm://ttmo-prd/storix#db-password");
    assert.doesNotMatch(error.message, /leak|plain-secret|12345/);
    assert.equal(error.cause, undefined);
    server.close();
    await once(server, "close");
  }
});

test("형식이 틀린 키는 SDK 호출 전에 거부한다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, { SecretString: JSON_SECRET }),
  );

  for (const ref of [
    "aws-sm://ttmo-prd/storix#",
    "aws-sm://#db-password",
    "aws-sm://ttmo-prd/storix#a#b",
    "aws-sm://ttmo-prd/storix#db password",
    "aws-sm://ttmo-prd/storix#a/b",
    "aws-sm://ttmo-prd/storix#한글",
    "aws-sm://ttmo-prd/storix#a\n",
  ]) {
    await rejectionOf(ref);
  }
  assert.equal(requests.length, 0);
});

test("JSON에 실제로 적힌 키는 이름이 __proto__여도 own 속성으로 읽고 중복 키는 마지막 값을 쓴다", async () => {
  await startFixture((_request, response) =>
    respond(response, 200, {
      SecretString: '{"__proto__":"own-value","dup":"first","dup":"last"}',
    }),
  );
  const adapter = await loadAdapter();
  const signal = new AbortController().signal;

  assert.equal(
    await adapter.resolve("aws-sm://s#__proto__", { signal }),
    "own-value",
  );
  assert.equal(await adapter.resolve("aws-sm://s#dup", { signal }), "last");
});
