#!/usr/bin/env node
// CHANGELOG.md에서 특정 버전(`## [X.Y.Z]`)의 섹션만 잘라내 릴리즈 노트로 쓴다.
// 섹션을 찾지 못하면(작성자가 [Unreleased]를 버전 섹션으로 옮기는 걸 잊은 경우)
// 실패시킨다 — 빈 릴리즈 노트로 릴리즈를 만들지 않는다.

import { readFileSync, writeFileSync } from 'node:fs';

export function extractSection(changelog, version) {
  const lines = changelog.split('\n');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^## \\[${escapedVersion}\\]`);

  const startIndex = lines.findIndex((line) => headingPattern.test(line));
  if (startIndex === -1) {
    throw new Error(`CHANGELOG.md에서 "## [${version}]" 섹션을 찾을 수 없음`);
  }

  let endIndex = lines.findIndex((line, index) => index > startIndex && /^## \[/.test(line));
  if (endIndex === -1) {
    endIndex = lines.length;
  }

  const section = lines.slice(startIndex + 1, endIndex).join('\n').trim();
  if (!section) {
    throw new Error(`"## [${version}]" 섹션이 비어 있음`);
  }

  return section;
}

async function main() {
  const [version, changelogPath, outputPath] = process.argv.slice(2);
  if (!version || !changelogPath || !outputPath) {
    console.error('사용법: extract-changelog-section.mjs <version> <changelogPath> <outputPath>');
    process.exitCode = 1;
    return;
  }

  const changelog = readFileSync(changelogPath, 'utf8');
  const section = extractSection(changelog, version);

  writeFileSync(outputPath, `${section}\n`, 'utf8');
  console.log(`릴리즈 노트를 ${outputPath}에 썼음 (${section.split('\n').length}줄)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
