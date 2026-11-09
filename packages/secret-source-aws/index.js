import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * AWS Secrets Manager의 SecretString을 읽는 어댑터다. docs/design/15-secret-sources.md "어댑터 계약"을 따른다.
 * 참조는 `aws-sm://<SecretId>` 또는 `aws-sm://<SecretId>#<키>`다.
 * 키가 있으면 SecretString을 JSON 객체로 읽어 그 키의 문자열 값만 반환한다.
 */
const SCHEME_PREFIX = "aws-sm://";

// SecretId와 ARN에는 `#`이 들어갈 수 없어 첫 `#`이 구분자로 모호하지 않다. 키의 `#`은 허용하지 않는다.
const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * 참조에서 SecretId와 JSON 키를 나눈다. 키가 없으면 `key`는 undefined다.
 * @param {string} ref
 * @returns {{ secretId: string, key: string | undefined }}
 */
function parseRef(ref) {
  const rest = ref.slice(SCHEME_PREFIX.length);
  const hash = rest.indexOf("#");
  if (hash < 0) {
    return { secretId: rest, key: undefined };
  }
  const key = rest.slice(hash + 1);
  // 형식이 틀린 키는 메시지에 싣지 않는다.
  if (!KEY_PATTERN.test(key)) {
    throw new Error("aws-sm 키 형식이 올바르지 않습니다");
  }
  return { secretId: rest.slice(0, hash), key };
}

/**
 * SecretString에서 키의 문자열 값을 고른다.
 * 오류 메시지에는 키 이름만 쓴다. JSON 파싱 오류는 본문 일부를 담으므로 버린다.
 * @param {string} secretString
 * @param {string} key
 * @returns {string}
 */
function selectKey(secretString, key) {
  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error("aws-sm SecretString이 JSON이 아닙니다");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("aws-sm SecretString이 JSON 객체가 아닙니다");
  }
  // 상속 속성(constructor, toString 등)은 키로 인정하지 않는다. JSON에 실제로 적힌 키는 own 속성이라 허용한다.
  if (!Object.hasOwn(parsed, key)) {
    throw new Error(`aws-sm JSON에 키가 없습니다: ${key}`);
  }
  const value = parsed[key];
  if (typeof value !== "string") {
    throw new Error(`aws-sm JSON 키의 값이 문자열이 아닙니다: ${key}`);
  }
  return value;
}

/** @type {{ scheme: string; resolve: (ref: string, options: { signal: AbortSignal }) => Promise<string> }} */
const awsSecretSource = {
  scheme: "aws-sm",

  /** @param {string} ref @param {{ signal: AbortSignal }} options @returns {Promise<string>} */
  async resolve(ref, { signal }) {
    if (!ref.startsWith(SCHEME_PREFIX)) {
      throw new Error("aws-sm 참조 형식이 올바르지 않습니다");
    }

    const { secretId, key } = parseRef(ref);

    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("AWS_REGION이 설정되지 않았습니다");
    }

    if (!secretId) {
      throw new Error("aws-sm SecretId가 비어 있습니다");
    }

    const endpoint = process.env.STORIX_AWS_SM_ENDPOINT;
    const client = new SecretsManagerClient({
      region,
      ...(endpoint ? { endpoint } : {}),
    });

    try {
      const result = await client.send(
        new GetSecretValueCommand({ SecretId: secretId }),
        {
          abortSignal: signal,
        },
      );
      if (typeof result.SecretString !== "string") {
        throw new Error("Secrets Manager 응답에 SecretString이 없습니다");
      }
      return key === undefined
        ? result.SecretString
        : selectKey(result.SecretString, key);
    } finally {
      client.destroy();
    }
  },
};

/** Storix SecretSource 로더가 불러올 기본 어댑터를 내보낸다. */
export default Object.freeze(awsSecretSource);
