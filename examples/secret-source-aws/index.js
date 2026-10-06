import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const SCHEME_PREFIX = "aws-sm://";

/** @type {{ scheme: string; resolve: (ref: string, options: { signal: AbortSignal }) => Promise<string> }} */
const awsSecretSource = {
  scheme: "aws-sm",

  /** @param {string} ref @param {{ signal: AbortSignal }} options @returns {Promise<string>} */
  async resolve(ref, { signal }) {
    if (!ref.startsWith(SCHEME_PREFIX)) {
      throw new Error("aws-sm 참조 형식이 올바르지 않습니다");
    }

    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("AWS_REGION이 설정되지 않았습니다");
    }

    const secretId = ref.slice(SCHEME_PREFIX.length);
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
      return result.SecretString;
    } finally {
      client.destroy();
    }
  },
};

export default Object.freeze(awsSecretSource);
