import http from "node:http";

/**
 * 테스트용 가짜 OpenBao다. AppRole 로그인과 KV v2 읽기만 흉내 낸다.
 * @param {{ roleId?: string, secretId?: string, token?: string, kv?: Record<string, Record<string, unknown>>,
 *   denyRead?: boolean, loginDelayMs?: number,
 *   loginRaw?: { status: number, body: string }, readRaw?: { status: number, body: string } }} options
 */
export async function startFakeBao({
  roleId = "role-1",
  secretId = "secret-1",
  token = "tok-1",
  kv = {},
  denyRead = false,
  loginDelayMs = 0,
  loginRaw,
  readRaw,
} = {}) {
  const calls = { login: 0, read: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const raw = ({ status, body: text }) => {
        res.writeHead(status, { "content-type": "text/html" });
        res.end(text);
      };

      if (req.method === "POST" && req.url === "/v1/auth/approle/login") {
        calls.login += 1;
        setTimeout(() => {
          if (loginRaw) return raw(loginRaw);
          let payload;
          try {
            payload = JSON.parse(body);
          } catch {
            return json(400, { errors: ["bad request"] });
          }
          if (payload.role_id === roleId && payload.secret_id === secretId) {
            return json(200, { auth: { client_token: token } });
          }
          return json(400, { errors: ["invalid credentials"] });
        }, loginDelayMs);
        return;
      }

      const match = req.url.match(/^\/v1\/([^/]+)\/data\/(.+)$/);
      if (req.method === "GET" && match) {
        calls.read += 1;
        if (readRaw) return raw(readRaw);
        if (denyRead || req.headers["x-vault-token"] !== token) {
          return json(403, { errors: ["permission denied"] });
        }
        const entry = kv[`${match[1]}/${match[2]}`];
        if (!entry) return json(404, { errors: [] });
        return json(200, { data: { data: entry, metadata: {} } });
      }
      return json(404, { errors: [] });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    addr: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
