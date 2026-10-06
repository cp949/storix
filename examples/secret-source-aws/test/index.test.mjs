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

/** 예제 어댑터의 기본 export를 불러온다. */
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
