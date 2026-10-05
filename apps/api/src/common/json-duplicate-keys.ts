// 객체 하나를 지나는 동안의 위치 정보다. 중복 key 오류 메시지의 경로를 만든다.
type Frame =
  | { readonly kind: 'object'; readonly keys: Set<string>; currentKey: string | null; expectKey: boolean }
  | { readonly kind: 'array'; index: number };

function pathOf(frames: readonly Frame[]): string {
  const segments = frames.map((frame) =>
    frame.kind === 'object' ? (frame.currentKey ?? '') : String(frame.index),
  );
  return segments.length === 0 ? '$' : segments.join('.');
}

/**
 * 문법이 유효한 JSON 텍스트에서 같은 객체 안의 중복 key를 찾아 오류를 던진다.
 * `JSON.parse`는 중복 key를 마지막 값으로 덮어써 설정 병합 실수를 감추므로, 파싱 전에 호출한다.
 * key는 이스케이프를 해석한 뒤 비교한다(`"a"`와 `"a"`는 같은 key다).
 * 문법 검사는 하지 않는다. 호출자가 `JSON.parse`로 먼저 확인해야 한다.
 */
export function assertNoDuplicateJsonKeys(text: string): void {
  const frames: Frame[] = [];
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position];
    const top = frames.at(-1);
    if (char === '{') {
      frames.push({ kind: 'object', keys: new Set(), currentKey: null, expectKey: true });
    } else if (char === '[') {
      frames.push({ kind: 'array', index: 0 });
    } else if (char === '}' || char === ']') {
      frames.pop();
    } else if (char === ',') {
      if (top?.kind === 'array') top.index += 1;
      else if (top?.kind === 'object') top.expectKey = true;
    } else if (char === '"') {
      // 문자열 끝까지 건너뛴다. 이스케이프된 따옴표는 닫는 따옴표가 아니다.
      let end = position + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (top?.kind === 'object' && top.expectKey) {
        const key = JSON.parse(text.slice(position, end + 1)) as string;
        if (top.keys.has(key)) {
          throw new Error(`Duplicate key "${key}" at ${pathOf(frames.slice(0, -1))}`);
        }
        top.keys.add(key);
        top.currentKey = key;
        top.expectKey = false;
      }
      position = end;
    }
  }
}
