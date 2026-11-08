import { readFile } from "node:fs/promises";
import { BaoError } from "../errors.js";

/**
 * AppRole로 로그인해 토큰을 돌려준다. `secret_id`는 파일에서 읽고 끝 줄바꿈 하나만 제거한다.
 * @param {{ addr: string, roleId: string, secretIdFile: string, fetchImpl: typeof fetch }} config
 * @param {{ signal: AbortSignal }} options
 * @returns {Promise<string>}
 */
export async function login(
  { addr, roleId, secretIdFile, fetchImpl },
  { signal },
) {
  if (!roleId || !secretIdFile) {
    throw new BaoError("auth-config");
  }
  let secretId;
  try {
    secretId = (await readFile(secretIdFile, "utf8")).replace(/\r?\n$/, "");
  } catch {
    throw new BaoError("auth-config");
  }
  if (!secretId) {
    throw new BaoError("auth-config");
  }

  let res;
  try {
    res = await fetchImpl(`${addr}/v1/auth/approle/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      signal,
    });
  } catch {
    throw new BaoError(signal?.aborted ? "aborted" : "network");
  }
  // OpenBao는 잘못된 자격증명에 400, CIDR 불일치 등 권한 거부에 403을 돌려준다.
  if (res.status === 400 || res.status === 403) {
    throw new BaoError("auth-failed");
  }
  if (!res.ok) {
    throw new BaoError("bad-response");
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new BaoError("bad-response");
  }
  const token = body?.auth?.client_token;
  if (typeof token !== "string" || token === "") {
    throw new BaoError("bad-response");
  }
  return token;
}
