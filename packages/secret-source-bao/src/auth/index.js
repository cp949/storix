import { BaoError } from "../errors.js";
import * as approle from "./approle.js";

// 로그인 방식을 추가할 때 이 표에 모듈을 넣는다. 참조 형식과 compose의 X_REF 값은 바뀌지 않는다.
const METHODS = { approle };

/**
 * @param {string} name
 * @returns {{ login: typeof approle.login }}
 */
export function getAuthMethod(name) {
  if (!Object.hasOwn(METHODS, name)) {
    throw new BaoError("auth-method");
  }
  return METHODS[name];
}
