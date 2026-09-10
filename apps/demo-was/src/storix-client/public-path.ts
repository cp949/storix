import { createHash } from 'node:crypto';

// 발행마다 이 함수가 만드는 세그먼트가 PUBLIC namespace 안에서의 실제 저장
// 경로가 된다. 원본 internalPath(사용자 root prefix 포함)를 그대로 재사용하면
// 공개 URL에 namespace/사용자 식별 정보가 노출되고, 서로 다른 사용자가 같은
// 파일명을 발행하면 충돌한다 — 그래서 경로 전체를 해시해 접두어로 쓰고
// 파일명만 남긴다. 해시가 결정적이므로 publish/unpublish가 같은 internalPath
// 에서 항상 같은 publicPath를 얻는다(별도 매핑 저장이 필요 없다).
export function derivePublicPath(internalPath: string): string {
  const segments = internalPath.split('/').filter((segment) => segment.length > 0);
  const filename = segments.at(-1) ?? 'file';
  const digest = createHash('sha256').update(internalPath).digest('hex').slice(0, 16);
  return `${digest}/${filename}`;
}
