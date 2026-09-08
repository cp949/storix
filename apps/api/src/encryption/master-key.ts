const KEY_LENGTH_BYTES = 32;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

export function parseMasterKey(rawValue: string | undefined): Buffer | null {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return null;
  }

  if (!HEX_KEY_PATTERN.test(rawValue)) {
    throw new Error(
      `STORIX_ENCRYPTION_MASTER_KEY 형식이 올바르지 않음 — openssl rand -hex 32 로 생성한 ${KEY_LENGTH_BYTES}바이트(hex 64자) 값이어야 한다.`,
    );
  }

  return Buffer.from(rawValue, 'hex');
}
