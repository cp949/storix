import type { ProfileName } from '../define-contract.ts';

/** 프로필별로 서버 기동 env에 덧씌우는 값. `default`는 서버 기본값을 그대로 쓴다. */
export const PROFILE_ENV: Readonly<Record<ProfileName, Readonly<Record<string, string>>>> = {
  default: {},
};
