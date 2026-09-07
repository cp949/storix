export interface MetricCounter {
  inc(labels?: Record<string, string>, value?: number): void;
}

export interface MetricHistogram {
  observe(value: number, labels?: Record<string, string>): void;
}

export interface MetricsRegistry {
  counter(name: string, help: string, labelNames?: string[]): MetricCounter;
  histogram(name: string, help: string, buckets: number[], labelNames?: string[]): MetricHistogram;
}
