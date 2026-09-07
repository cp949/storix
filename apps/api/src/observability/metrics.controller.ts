import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { PrometheusMetricsRegistry } from './prometheus-metrics-registry.js';

@Public()
@Controller()
export class MetricsController {
  constructor(private readonly registry: PrometheusMetricsRegistry) {}

  @Get('metrics')
  async getMetrics(@Res() res: Response): Promise<void> {
    res.set('Content-Type', this.registry.contentType);
    res.send(await this.registry.metrics());
  }
}
