import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSection } from './extract-changelog-section.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- 다음 버전 예정 항목

## [1.2.3] - 2026-09-08

### Added

- 기능 A
- 기능 B

### Fixed

- 버그 C

## [1.2.2] - 2026-08-01

### Fixed

- 이전 버그
`;

test('해당 버전 섹션만 다음 헤딩 전까지 잘라낸다', () => {
  const section = extractSection(CHANGELOG, '1.2.3');
  assert.match(section, /기능 A/);
  assert.match(section, /버그 C/);
  assert.doesNotMatch(section, /이전 버그/);
  assert.doesNotMatch(section, /다음 버전 예정 항목/);
});

test('마지막 섹션은 파일 끝까지 잘라낸다', () => {
  const section = extractSection(CHANGELOG, '1.2.2');
  assert.match(section, /이전 버그/);
});

test('없는 버전은 에러를 던진다', () => {
  assert.throws(() => extractSection(CHANGELOG, '9.9.9'), /찾을 수 없음/);
});

test('섹션이 비어 있으면 에러를 던진다', () => {
  const empty = `## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-01-01\n\n내용\n`;
  assert.throws(() => extractSection(empty, '1.0.0'), /비어 있음/);
});
