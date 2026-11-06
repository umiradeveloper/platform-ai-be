import { Controller, Get, Header, Global, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { collectDefaultMetrics, Counter, Histogram, register } from 'prom-client';
import { Public } from './auth.decorators';

collectDefaultMetrics({ prefix: 'umira_ai_' });

export const aiRequests = new Counter({
  name: 'umira_ai_llm_requests_total',
  help: 'Jumlah request ke provider AI',
  labelNames: ['provider', 'model', 'status'] as const,
});

export const aiTokens = new Counter({
  name: 'umira_ai_llm_tokens_total',
  help: 'Jumlah token yang diproses',
  labelNames: ['provider', 'model', 'direction'] as const,
});

export const aiLatency = new Histogram({
  name: 'umira_ai_llm_latency_seconds',
  help: 'Latency respons provider AI (sampai selesai)',
  labelNames: ['provider', 'model'] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160],
});

@ApiExcludeController()
@Controller()
export class MetricsController {
  /** Endpoint Prometheus. Di production, batasi aksesnya lewat Nginx (lihat deploy/nginx.conf). */
  @Public()
  @Get('metrics')
  @Header('Content-Type', register.contentType)
  metrics() {
    return register.metrics();
  }
}

@Global()
@Module({ controllers: [MetricsController] })
export class MetricsModule {}
