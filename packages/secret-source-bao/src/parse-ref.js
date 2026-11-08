import { BaoError } from "./errors.js";

const PREFIX = "bao://";
// "."과 ".."는 경로 이동이라 거부한다.
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const FIELD = /^[A-Za-z0-9_.-]+$/;

/**
 * `bao://<마운트>/<경로>#<필드>`를 나눈다. 형식이 틀리면 `invalid-ref`를 던진다.
 * @param {unknown} ref
 * @returns {{ mount: string, path: string, field: string }}
 */
export function parseRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith(PREFIX)) {
    throw new BaoError("invalid-ref");
  }
  const rest = ref.slice(PREFIX.length);
  const hash = rest.indexOf("#");
  if (hash < 0) {
    throw new BaoError("invalid-ref");
  }
  const segments = rest.slice(0, hash).split("/");
  const field = rest.slice(hash + 1);
  if (
    segments.length < 2 ||
    !segments.every((s) => SEGMENT.test(s)) ||
    !FIELD.test(field)
  ) {
    throw new BaoError("invalid-ref");
  }
  const [mount, ...path] = segments;
  return { mount, path: path.join("/"), field };
}
