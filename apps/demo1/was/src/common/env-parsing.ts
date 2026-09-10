export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`잘못된 정수 환경변수 값: ${value}`);
  }
  return parsed;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`필수 환경변수가 설정되지 않음: ${name}`);
  }
  return value;
}

export function parseOptionalString(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
