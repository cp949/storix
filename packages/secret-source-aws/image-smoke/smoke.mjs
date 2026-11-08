/**
 * -aws 이미지 안에서 어댑터 로드와 X_REF 해석을 확인한다.
 * 가짜 Secrets Manager는 127.0.0.1에만 뜨고 STORIX_AWS_SM_ENDPOINT로 연결한다. 시험 값은 모두 SMOKE-SENTINEL을 포함하며 출력하지 않는다.
 * 실행: .github/scripts/adapter-image-smoke.sh (이 파일을 /smoke에 읽기 전용으로 마운트한다)
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ADAPTER = "storix-secret-source-aws";
const VALUE = "SMOKE-SENTINEL-value";
const ACCESS_KEY = "SMOKE-SENTINEL-access-key";
const SECRET_KEY = "SMOKE-SENTINEL-secret-key";

const { resolveSecrets } = await import(
  pathToFileURL("/repo/apps/api/dist/secrets/resolve-secrets.js").href
);
const requireFromApi = createRequire("/repo/apps/api/package.json");

/** GetSecretValue만 흉내 낸다. SecretId가 example/api-key면 값을, 아니면 ResourceNotFoundException을 답한다. */
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { SecretId } = JSON.parse(body);
  const headers = {
    "content-type": "application/x-amz-json-1.1",
    "x-amzn-requestid": "smoke",
  };
  if (
    request.headers["x-amz-target"] === "secretsmanager.GetSecretValue" &&
    SecretId === "example/api-key"
  ) {
    response.writeHead(200, headers);
    response.end(JSON.stringify({ Name: SecretId, SecretString: VALUE }));
    return;
  }
  response.writeHead(400, {
    ...headers,
    "x-amzn-errortype": "ResourceNotFoundException",
  });
  response.end(
    JSON.stringify({
      __type: "ResourceNotFoundException",
      message: "Secrets Manager can't find the specified secret.",
    }),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

// 어댑터는 process.env에서 AWS 설정을 읽는다.
Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY: SECRET_KEY,
  AWS_EC2_METADATA_DISABLED: "true",
  STORIX_AWS_SM_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
});

/** resolveSecrets를 호출해 던진 오류를 돌려준다. 성공하면 undefined다. */
async function failureOf(env) {
  try {
    await resolveSecrets(env);
  } catch (error) {
    return error;
  }
  return undefined;
}

const baseEnv = { STORIX_SECRET_ADAPTERS: ADAPTER };

try {
  // 1. 참조를 해석해 값을 채운다.
  const env = { ...baseEnv, STORIX_API_KEY_REF: "aws-sm://example/api-key" };
  await resolveSecrets(env);
  assert.equal(env.STORIX_API_KEY, VALUE);

  // 2. 없는 비밀은 값 없이 실패한다.
  const missing = await failureOf({
    ...baseEnv,
    STORIX_API_KEY_REF: "aws-sm://example/missing",
  });
  assert.equal(missing?.name, "SecretResolutionError");
  assert.equal(missing.failures[0].name, "STORIX_API_KEY");
  for (const sentinel of [VALUE, ACCESS_KEY, SECRET_KEY]) {
    assert.ok(!String(missing.message).includes(sentinel));
  }

  // 3. 옛 패키지명과 다른 어댑터는 로드 오류로 끝난다.
  for (const specifier of [
    "storix-secret-source-aws-example",
    "storix-secret-source-bao",
  ]) {
    const loadFailure = await failureOf({ STORIX_SECRET_ADAPTERS: specifier });
    assert.equal(loadFailure?.name, "SecretAdapterLoadError");
    assert.equal(loadFailure.failures[0].kind, "not-found");
  }

  console.log("aws 이미지 스모크 통과: 참조 해석, 없는 비밀 실패, 로드 오류");
} finally {
  server.closeAllConnections();
  server.close();
}
