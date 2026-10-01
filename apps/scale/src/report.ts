/** 저장된 측정 JSON을 비교용 마크다운 표로 바꾼다. */

interface Phase {
  readonly ok: boolean;
  readonly error: string | null;
  readonly data: Record<string, any> | null;
}

/** 결과 JSON에서 보고서가 읽는 필드. */
export interface ReportInput {
  readonly runId: string;
  readonly label: string;
  readonly spec: { readonly namespaces: number };
  readonly phases: Record<string, Phase>;
}

function mib(bytes: number | undefined): string {
  return bytes === undefined || bytes === 0 ? '-' : `${(bytes / 1048576).toFixed(0)}`;
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '-'
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}s`
      : `${value.toFixed(1)}ms`;
}

function cell(phase: Phase | undefined, value: (data: Record<string, any>) => string): string {
  if (phase === undefined) return '미측정';
  if (phase.data === null) return `실패(${(phase.error ?? '').split('\n')[0].slice(0, 40)})`;
  const text = value(phase.data);
  return phase.ok ? text : `실패: ${text}`;
}

/** 결과 목록을 규모·label 순으로 비교표 문자열로 만든다. */
export function renderReport(results: readonly ReportInput[]): string {
  const sorted = [...results].sort(
    (a, b) => a.label.localeCompare(b.label) || a.spec.namespaces - b.spec.namespaces,
  );
  const lines: string[] = [];
  lines.push(
    '| label | namespace | API 시작 | 시작 RSS(MiB) | 시작+capability(목록) | 시작+capability(기본 활성) | GC wall | GC 최대 RSS(MiB) | list 응답 | list 크기(MiB) | list 최대 RSS(MiB) | page100 첫 page | page1000 전체 순회 | page 최대 RSS(MiB) | 요청 최대 RSS(MiB) |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of sorted) {
    const p = r.phases;
    lines.push(
      `| ${r.label} | ${r.spec.namespaces} | ${cell(p.startup, (d) => ms(d.startupMs))} | ${cell(p.startup, (d) => mib(d.readyRssBytes))} | ${cell(p['startup-capability'], (d) => `${ms(d.startupMs)} (K=${d.capabilityNamespaces})`)} | ${cell(p['startup-capability-default'], (d) => ms(d.startupMs))} | ${cell(p.gc, (d) => ms(d.wallMs))} | ${cell(p.gc, (d) => mib(d.peakRssBytes))} | ${cell(p.list, (d) => (d.first.ok ? ms(d.first.ms) : `실패 ${d.first.error ?? d.first.status}`))} | ${cell(p.list, (d) => mib(d.first.bytes))} | ${cell(p.list, (d) => mib(d.peakRssBytes))} | ${cell(p['list-pages'], (d) => ms(d.page100.firstPageMs))} | ${cell(p['list-pages'], (d) => `${ms(d.page1000.totalMs)} (${d.page1000.pages} page)`)} | ${cell(p['list-pages'], (d) => mib(d.peakRssBytes))} | ${cell(p.requests, (d) => mib(d.peakRssBytes))} |`,
    );
  }
  lines.push('');
  lines.push('| label | namespace | 요청 | p50 | p95 | 시도 | 실패 | 처리량/s |');
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of sorted) {
    const results = r.phases.requests?.data?.results as Record<string, any> | undefined;
    if (results === undefined) continue;
    for (const [name, s] of Object.entries(results)) {
      lines.push(
        `| ${r.label} | ${r.spec.namespaces} | ${name} | ${ms(s.p50Ms)} | ${ms(s.p95Ms)} | ${s.count} | ${s.failures} | ${s.throughputPerSec?.toFixed(1) ?? '-'} |`,
      );
    }
  }
  return lines.join('\n');
}
