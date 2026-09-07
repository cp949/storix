import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricCounter, MetricHistogram, MetricsRegistry } from './metrics-registry.js';

@Injectable()
export class PrometheusMetricsRegistry implements MetricsRegistry {
  readonly registry = new Registry();

  private readonly counters = new Map<string, Counter<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  counter(name: string, help: string, labelNames: string[] = []): MetricCounter {
    const promCounter = this.getOrCreateCounter(name, help, labelNames);
    return {
      inc: (labels, value) => {
        if (labels) {
          promCounter.inc(labels, value);
        } else {
          promCounter.inc(value);
        }
      },
    };
  }

  histogram(name: string, help: string, buckets: number[], labelNames: string[] = []): MetricHistogram {
    const promHistogram = this.getOrCreateHistogram(name, help, buckets, labelNames);
    return {
      observe: (value, labels) => {
        if (labels) {
          promHistogram.observe(labels, value);
        } else {
          promHistogram.observe(value);
        }
      },
    };
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private getOrCreateCounter(name: string, help: string, labelNames: string[]): Counter<string> {
    const existing = this.counters.get(name);
    if (existing) {
      return existing;
    }
    const created = new Counter({ name, help, labelNames, registers: [this.registry] });
    this.counters.set(name, created);
    return created;
  }

  private getOrCreateHistogram(name: string, help: string, buckets: number[], labelNames: string[]): Histogram<string> {
    const existing = this.histograms.get(name);
    if (existing) {
      return existing;
    }
    const created = new Histogram({ name, help, labelNames, buckets, registers: [this.registry] });
    this.histograms.set(name, created);
    return created;
  }
}
