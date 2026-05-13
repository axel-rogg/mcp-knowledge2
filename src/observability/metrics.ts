// Prometheus metrics. Exposed via GET /metrics.
//
// Metric names follow prom-conventions: _total for counters, _seconds for
// duration histograms.

import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'knowledge_' });

export const httpRequestCounter = new Counter({
  name: 'knowledge_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'knowledge_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'path'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const embeddingCalls = new Counter({
  name: 'knowledge_embedding_calls_total',
  help: 'Vertex embedding API calls',
  labelNames: ['task_type', 'result'],
  registers: [registry],
});

export const auditEvents = new Counter({
  name: 'knowledge_audit_events_total',
  help: 'Audit events emitted',
  labelNames: ['action', 'result'],
  registers: [registry],
});

export const dekResolveCalls = new Counter({
  name: 'knowledge_dek_resolve_total',
  help: 'KMS DEK-resolve calls to mcp-approval2',
  labelNames: ['result'],
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
