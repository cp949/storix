import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const baseImage = "storix-secret-source-localstack-base:local";
const appImage = "storix-secret-source-localstack-app:local";
const apiKey = "localstack-example-api-key-0123456789abcdef";
const masterKey =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const skipBuild = process.argv.includes("--skip-build");

function readAuthToken() {
  const configured = process.env.LOCALSTACK_AUTH_TOKEN;
  if (configured) return configured;
  const result = spawnSync("pass", ["show", "localstack/auth-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("LocalStack Auth Token을 pass에서 읽지 못했다");
  }
  return result.stdout.replace(/\r?\n$/, "");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 900_000,
    env: options.env,
  });
  if (result.error)
    throw new Error(`${command} 실행 실패 (${result.error.code ?? "unknown"})`);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertNoSecretOutput(output, token, phase) {
  assert.equal(
    output.includes(apiKey),
    false,
    `${phase}: API 키가 출력에 나타남`,
  );
  assert.equal(
    output.includes(masterKey),
    false,
    `${phase}: 마스터 키가 출력에 나타남`,
  );
  assert.equal(
    output.includes(token),
    false,
    `${phase}: Auth Token이 출력에 나타남`,
  );
}

function cleanComposeEnvironment(token) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("STORIX_") || name.startsWith("AWS_")) delete env[name];
  }
  for (const name of [
    "COMPOSE_FILE",
    "COMPOSE_PROFILES",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    LOCALSTACK_AUTH_TOKEN: token,
    STORIX_BASE_IMAGE: baseImage,
    STORIX_APP_IMAGE: appImage,
    STORIX_LOCALSTACK_DEMO_PORT: "31987",
    STORIX_PUBLISH_HOST: "127.0.0.1",
    STORIX_PUBLISH_PORT: "31987",
    STORIX_LOCALSTACK_API_KEY: apiKey,
    STORIX_EXAMPLE_MASTER_KEY: masterKey,
    STORIX_STORAGE_ACCESS_KEY: "storix-example",
    STORIX_STORAGE_SECRET_KEY: "storix-example-secret",
    STORIX_STORAGE_BUCKET: "storix-localstack-example",
  });
  return env;
}

function composeArgs(project, emptyEnvPath) {
  return [
    "--project-name",
    project,
    "--env-file",
    emptyEnvPath,
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.sqlite.yml",
    "-f",
    "docker-compose.versitygw.yml",
    "-f",
    "docs/deployment/scenarios/aws-secrets-localstack/compose.localstack.yml",
  ];
}

function assertNoProjectResources(project) {
  const containers = run("docker", [
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  const volumes = run("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  assert.equal(containers.status, 0, "Docker container 목록을 확인하지 못했다");
  assert.equal(volumes.status, 0, "Docker volume 목록을 확인하지 못했다");
  assert.equal(containers.stdout.trim(), "", "전용 project 컨테이너가 남았다");
  assert.equal(volumes.stdout.trim(), "", "전용 project 볼륨이 남았다");
}

function interruptAfterSecretInit() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "docs/deployment/scenarios/aws-secrets-localstack/run.sh",
        "--skip-build",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let interrupted = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("초기화 뒤 중단 검증이 180초 제한을 넘었다"));
    }, 180_000);
    const collect = (chunk) => {
      output += chunk;
      if (!interrupted && output.includes("LocalStack Secret 초기화 완료")) {
        interrupted = child.kill("SIGTERM");
      }
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`중단 runner 실행 실패 (${error.code ?? "unknown"})`));
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      try {
        assertNoSecretOutput(output, token, "초기화 뒤 중단 시나리오");
        assert.equal(
          interrupted,
          true,
          "Secret 초기화 완료 뒤 종료 신호를 보내지 못했다",
        );
        assert.equal(
          status,
          143,
          "SIGTERM trap이 종료 코드 143을 반환하지 않았다",
        );
        const project = output.match(
          /예제 실패 또는 정리 실패: project=([a-z0-9-]+)/,
        )?.[1];
        assert.ok(project, "중단된 project 이름을 찾지 못했다");
        resolve(project);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const token = readAuthToken();
const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "storix-localstack-verify-"),
);
const emptyEnvPath = path.join(temporaryDirectory, "empty.env");
writeFileSync(emptyEnvPath, "");
let keptProject;

try {
  const successArgs = [
    "docs/deployment/scenarios/aws-secrets-localstack/run.sh",
    "--keep",
  ];
  if (skipBuild) successArgs.push("--skip-build");
  const success = run("bash", successArgs);
  const successOutput = `${success.stdout}\n${success.stderr}`;
  assertNoSecretOutput(successOutput, token, "정상 시나리오");
  assert.equal(success.status, 0, "정상 시나리오가 실패했다");
  keptProject = successOutput.match(/프로젝트 유지: project=([a-z0-9-]+)/)?.[1];
  assert.ok(keptProject, "실행 project 이름을 찾지 못했다");

  const compose = ["compose", ...composeArgs(keptProject, emptyEnvPath)];
  const missingSecret = run(
    "docker",
    [
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "-e",
      "STORIX_API_KEY_REF=aws-sm://storix/localstack/not-found",
      "--entrypoint",
      "node",
      "app",
      "apps/api/dist/main.js",
    ],
    { timeout: 60_000, env: cleanComposeEnvironment(token) },
  );
  const missingOutput = `${missingSecret.stdout}\n${missingSecret.stderr}`;
  assertNoSecretOutput(missingOutput, token, "없는 Secret 시나리오");
  assert.equal(missingSecret.status, 1, "없는 Secret은 종료 코드 1이어야 한다");
  assert.match(
    missingOutput,
    /STORIX_API_KEY\(aws-sm\): adapter-error/,
    "값 없는 adapter-error를 확인하지 못했다",
  );

  const timeout = run(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      appImage,
      "/opt/storix-secret-source-aws-example/verify-exit.mjs",
    ],
    { timeout: 120_000 },
  );
  const timeoutOutput = `${timeout.stdout}\n${timeout.stderr}`;
  assertNoSecretOutput(timeoutOutput, token, "job timeout 시나리오");
  assert.equal(timeout.status, 0, "job timeout 시나리오가 실패했다");
  assert.match(timeoutOutput, /gc, backup, restore 3\/3; HTTP 연결 닫힘 3\/3/);

  const down = run(
    "docker",
    [...compose, "down", "--volumes", "--remove-orphans"],
    {
      timeout: 60_000,
      env: cleanComposeEnvironment(token),
    },
  );
  assert.equal(down.status, 0, "검증 project 정리가 실패했다");
  assertNoProjectResources(keptProject);
  keptProject = undefined;

  const repeat = run("bash", [
    "docs/deployment/scenarios/aws-secrets-localstack/run.sh",
    "--skip-build",
  ]);
  const repeatOutput = `${repeat.stdout}\n${repeat.stderr}`;
  assertNoSecretOutput(repeatOutput, token, "재실행 시나리오");
  assert.equal(repeat.status, 0, "이미지 재사용 재실행이 실패했다");
  const repeatProject = repeatOutput.match(
    /정리 완료: project=([a-z0-9-]+)/,
  )?.[1];
  assert.ok(repeatProject, "재실행 project 이름을 찾지 못했다");
  assertNoProjectResources(repeatProject);

  const interruptedProject = await interruptAfterSecretInit();
  assertNoProjectResources(interruptedProject);

  console.log(
    "통합 검증 통과: 정상 API·없는 Secret·비노출·job timeout·정리·재실행·초기화 뒤 SIGTERM",
  );
} finally {
  if (keptProject) {
    run(
      "docker",
      [
        "compose",
        ...composeArgs(keptProject, emptyEnvPath),
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      { timeout: 60_000, env: cleanComposeEnvironment(token) },
    );
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
