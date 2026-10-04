/** 허용할 Namespace name 문법. DB `CHK_namespace_name_format`과 같다. */
export const NAMESPACE_NAME_PATTERN = /^[a-z0-9_-]{1,128}$/;

/** Namespace name이 저장·목록 cursor에 허용되는 표기인지 확인한다. */
export function isNamespaceName(value: string): boolean {
  return NAMESPACE_NAME_PATTERN.test(value);
}
