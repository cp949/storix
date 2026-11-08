/**
 * -bao 이미지 안에서 어댑터 로드와 X_REF 해석을 확인한다.
 * 가짜 OpenBao는 127.0.0.1에만 뜬다. 시험 값은 모두 SMOKE-SENTINEL을 포함하며 출력하지 않는다.
 * 실행: .github/scripts/adapter-image-smoke.sh (이 파일과 test-support를 /smoke에 읽기 전용으로 마운트한다)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startFakeBao } from "./test-support/fake-bao.mjs";

const ADAPTER = "storix-secret-source-bao";
const VALUE = "SMOKE-SENTINEL-value";
const TOKEN = "SMOKE-SENTINEL-token";
const ROLE_ID = "SMOKE-SENTINEL-role";
const SECRET_ID = "SMOKE-SENTINEL-secret-id";

const { resolveSecrets } = await import(
  pathToFileURL("/repo/apps/api/dist/secrets/resolve-secrets.js").href
);
const requireFromApi = createRequire("/repo/apps/api/package.json");

const bao = await startFakeBao({
  roleId: ROLE_ID,
  secretId: SECRET_ID,
  token: TOKEN,
  kv: { "kv/example/storix": { api_key: VALUE } },
});
const secretIdFile = path.join(
  mkdtempSync(path.join(tmpdir(), "smoke-")),
  "secret-id",
);
writeFileSync(secretIdFile, SECRET_ID);
// 어댑터는 process.env에서 BAO_* 설정을 읽는다.
Object.assign(process.env, {
  BAO_ADDR: bao.addr,
  BAO_ROLE_ID: ROLE_ID,
  BAO_SECRET_ID_FILE: secretIdFile,
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
  const env = {
    ...baseEnv,
    STORIX_API_KEY_REF: "bao://kv/example/storix#api_key",
  };
  await resolveSecrets(env);
  assert.equal(env.STORIX_API_KEY, VALUE);

  // 2. 없는 비밀은 값 없이 실패한다.
  const missing = await failureOf({
    ...baseEnv,
    STORIX_API_KEY_REF: "bao://kv/example/missing#api_key",
  });
  assert.equal(missing?.name, "SecretResolutionError");
  assert.equal(missing.failures[0].name, "STORIX_API_KEY");
  for (const sentinel of [VALUE, TOKEN, ROLE_ID, SECRET_ID]) {
    assert.ok(!String(missing.message).includes(sentinel));
  }

  // 3. 옛 패키지명과 다른 어댑터는 로드 오류로 끝난다.
  for (const specifier of [
    "storix-secret-source-aws-example",
    "storix-secret-source-aws",
  ]) {
    const loadFailure = await failureOf({ STORIX_SECRET_ADAPTERS: specifier });
    assert.equal(loadFailure?.name, "SecretAdapterLoadError");
    assert.equal(loadFailure.failures[0].kind, "not-found");
  }

  // 4. Secrets Manager 클라이언트는 이 이미지에 없다.
  assert.throws(
    () => requireFromApi.resolve("@aws-sdk/client-secrets-manager"),
    { code: "MODULE_NOT_FOUND" },
  );

  console.log(
    "bao 이미지 스모크 통과: 참조 해석, 없는 비밀 실패, 로드 오류, SDK 부재",
  );
} finally {
  await bao.close();
}
