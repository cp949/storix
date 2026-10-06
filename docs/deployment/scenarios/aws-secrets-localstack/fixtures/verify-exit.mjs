import { spawn } from "node:child_process";
import { createServer } from "node:http";

const jobs = [
  ["gc", "/repo/apps/api/dist/gc-main.js"],
  ["backup", "/repo/apps/api/dist/backup-main.js"],
  ["restore", "/repo/apps/api/dist/restore-main.js"],
];
const timeoutMs = 100;
const connections = [];
const server = createServer((request, response) => {
  request.resume();
  const closed = new Promise((resolve) => response.once("close", resolve));
  connections.push(closed);
  response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
  response.flushHeaders();
});
server.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const endpoint = `http://127.0.0.1:${server.address().port}`;
const childEnvironment = {
  ...process.env,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_EC2_METADATA_DISABLED: "true",
  STORIX_AWS_SM_ENDPOINT: endpoint,
  STORIX_SECRET_ADAPTERS: "storix-secret-source-aws-example",
  STORIX_SECRET_RESOLVE_TIMEOUT_MS: String(timeoutMs),
  STORIX_API_KEY: "",
  STORIX_API_KEY_FILE: "",
  STORIX_API_KEY_REF: "aws-sm://timeout",
  STORIX_API_KEY_PREVIOUS: "",
  STORIX_API_KEY_PREVIOUS_FILE: "",
  STORIX_API_KEY_PREVIOUS_REF: "",
};

function runJob(name, entrypoint) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [entrypoint], {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    const limitMs = 20_000 + timeoutMs + 5_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${name}: ${limitMs}ms 안에 종료되지 않음`));
    }, limitMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(`${name}: child 실행 실패 (${error.code ?? "unknown"})`),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("HTTP 연결이 닫히지 않음")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let completed = 0;
try {
  for (const [name, entrypoint] of jobs) {
    const result = await runJob(name, entrypoint);
    if (
      result.code !== 1 ||
      result.signal !== null ||
      !result.output.includes("timeout")
    ) {
      throw new Error(
        `${name}: timeout 오류와 종료 코드 1이 확인되지 않음 (code=${result.code})`,
      );
    }
    const connectionClosed = connections.shift();
    if (!connectionClosed)
      throw new Error(`${name}: fixture 요청이 도착하지 않음`);
    await withTimeout(connectionClosed, 2_000);
    completed += 1;
  }
  console.log(
    `timeout 종료 확인: gc, backup, restore ${completed}/3; HTTP 연결 닫힘 ${completed}/3`,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
