import { getAuthMethod } from "./src/auth/index.js";
import { BaoError } from "./src/errors.js";
import { parseRef } from "./src/parse-ref.js";

/**
 * Storix `SecretSource` 계약을 구현한다(Storix docs/design/15-secret-sources.md "어댑터 계약").
 * env와 fetch는 테스트에서 바꾼다.
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [options]
 */
export function createBaoSecretSource({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  /** @type {Promise<string> | undefined} */
  let tokenPromise;

  function readConfig() {
    const addr = (env.BAO_ADDR ?? "").replace(/\/+$/, "");
    if (!addr) {
      throw new BaoError("config");
    }
    return {
      addr,
      roleId: env.BAO_ROLE_ID ?? "",
      secretIdFile: env.BAO_SECRET_ID_FILE ?? "",
      fetchImpl,
    };
  }

  // 프로세스 안에서 로그인은 한 번이다. 실패하면 다음 호출이 다시 시도한다.
  function getToken(config, signal) {
    if (!tokenPromise) {
      const method = getAuthMethod(env.BAO_AUTH_METHOD || "approle");
      tokenPromise = method.login(config, { signal });
      tokenPromise.catch(() => {
        tokenPromise = undefined;
      });
    }
    return tokenPromise;
  }

  return Object.freeze({
    scheme: "bao",

    /** @param {string} ref @param {{ signal: AbortSignal }} options @returns {Promise<string>} */
    async resolve(ref, { signal }) {
      const { mount, path, field } = parseRef(ref);
      const config = readConfig();
      const token = await getToken(config, signal);

      let res;
      try {
        res = await fetchImpl(`${config.addr}/v1/${mount}/data/${path}`, {
          headers: { "x-vault-token": token },
          signal,
        });
      } catch {
        throw new BaoError(signal?.aborted ? "aborted" : "network");
      }
      if (res.status === 404) throw new BaoError("not-found");
      if (res.status === 403) throw new BaoError("forbidden");
      if (!res.ok) throw new BaoError("bad-response");

      let body;
      try {
        body = await res.json();
      } catch {
        throw new BaoError("bad-response");
      }
      const data = body?.data?.data;
      if (
        data === null ||
        typeof data !== "object" ||
        !Object.hasOwn(data, field)
      ) {
        throw new BaoError("not-found");
      }
      const value = data[field];
      // 코어는 값을 그대로 쓴다. 줄바꿈을 붙이거나 제거하지 않는다.
      if (typeof value !== "string" || value === "") {
        throw new BaoError("bad-response");
      }
      return value;
    },
  });
}

/** Storix 로더가 불러올 기본 어댑터다. */
export default createBaoSecretSource();
