import { PrometheusMetricsRegistry } from './prometheus-metrics-registry.js';

describe('PrometheusMetricsRegistry', () => {
  it('같은 이름으로 counter를 두 번 호출해도 하나의 시계열로 누적된다', async () => {
    const metrics = new PrometheusMetricsRegistry();

    metrics.counter('test_requests_total', 'test help').inc();
    metrics.counter('test_requests_total', 'test help').inc();

    const output = await metrics.metrics();
    expect(output).toContain('test_requests_total 2');
  });

  it('counter에 라벨과 증가폭을 지정하면 라벨별로 값이 누적된다', async () => {
    const metrics = new PrometheusMetricsRegistry();
    const counter = metrics.counter('test_bytes_total', 'test help', ['operation']);

    counter.inc({ operation: 'FsController.upload' }, 2048);

    const output = await metrics.metrics();
    expect(output).toContain('test_bytes_total{operation="FsController.upload"} 2048');
  });

  it('histogram에 값을 observe하면 count/sum이 출력에 반영된다', async () => {
    const metrics = new PrometheusMetricsRegistry();
    const histogram = metrics.histogram('test_duration_seconds', 'test help', [0.1, 1]);

    histogram.observe(0.05);

    const output = await metrics.metrics();
    expect(output).toContain('test_duration_seconds_count 1');
    expect(output).toContain('test_duration_seconds_sum 0.05');
  });

  it('histogram에 라벨을 지정하면 라벨별로 관측치가 기록된다', async () => {
    const metrics = new PrometheusMetricsRegistry();
    const histogram = metrics.histogram('test_labeled_duration_seconds', 'test help', [1], ['operation']);

    histogram.observe(0.5, { operation: 'FsController.download' });

    const output = await metrics.metrics();
    expect(output).toContain('test_labeled_duration_seconds_count{operation="FsController.download"} 1');
  });

  it('Node 프로세스 기본 지표(collectDefaultMetrics)를 포함한다', async () => {
    const metrics = new PrometheusMetricsRegistry();

    const output = await metrics.metrics();

    expect(output).toContain('process_cpu_user_seconds_total');
  });

  it('contentType은 Prometheus text exposition format을 가리킨다', () => {
    const metrics = new PrometheusMetricsRegistry();

    expect(metrics.contentType).toContain('text/plain');
  });
});
