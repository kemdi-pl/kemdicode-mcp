/**
 * KemdiCode MCP Server - Distributed Tracing (OpenTelemetry)
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Distributed Tracing System (OpenTelemetry compatible)
 *
 * Features:
 * - Span creation and management
 * - Context propagation
 * - Automatic instrumentation for tools
 * - Export to OTLP endpoints
 * - Sampling strategies
 *
 * @module utils/tracing
 */

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanAttributes {
  [key: string]: string | number | boolean;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
}

export interface Span {
  name: string;
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  attributes: SpanAttributes;
  status: SpanStatus;
  events: SpanEvent[];
  kind: SpanKind;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: SpanAttributes;
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface TracerConfig {
  serviceName: string;
  enabled: boolean;
  sampleRate: number;
  exporterEndpoint?: string;
  exportInterval: number;
}

export interface TraceExport {
  export(spans: Span[]): Promise<void>;
}

export class SpanImpl implements Span {
  name: string;
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  attributes: SpanAttributes;
  status: SpanStatus = 'unset';
  events: SpanEvent[] = [];
  kind: SpanKind;
  private ended = false;

  constructor(
    name: string,
    context: SpanContext,
    kind: SpanKind = 'internal',
    attributes: SpanAttributes = {}
  ) {
    this.name = name;
    this.spanId = context.spanId;
    this.traceId = context.traceId;
    this.parentSpanId = context.parentSpanId;
    this.startTime = Date.now();
    this.kind = kind;
    this.attributes = { ...attributes };
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.status = status;
    if (status === 'error' && message) {
      this.attributes['error.message'] = message;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.endTime = Date.now();
  }

  isEnded(): boolean {
    return this.ended;
  }
}

export class Tracer {
  private spans: SpanImpl[] = [];
  private context: SpanContext;
  private config: Required<TracerConfig>;
  private exporter: TraceExport | null = null;
  private sampler: () => boolean;

  constructor(config: Partial<TracerConfig> = {}) {
    this.config = {
      serviceName: config.serviceName ?? 'kemdicode-mcp',
      enabled: config.enabled ?? true,
      sampleRate: config.sampleRate ?? 1.0,
      exporterEndpoint: config.exporterEndpoint || undefined,
      exportInterval: config.exportInterval ?? 5000,
    } as Required<TracerConfig>;

    this.context = this.createTraceContext();
    this.sampler = () => Math.random() < this.config.sampleRate;

    if (this.config.exporterEndpoint) {
      this.setupExporter();
    }
  }

  private createTraceContext(): SpanContext {
    const traceId = this.generateId();
    const spanId = this.generateId();
    return {
      traceId,
      spanId,
      traceFlags: 1,
    };
  }

  private generateId(): string {
    const bytes = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private setupExporter(): void {
    const endpoint = this.config.exporterEndpoint;
    if (!endpoint) return;

    this.exporter = {
      export: async (spans: Span[]) => {
        try {
          await fetch(`${endpoint}/v1/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              resourceSpans: [
                {
                  resource: {
                    attributes: [
                      { key: 'service.name', value: { stringValue: this.config.serviceName } },
                    ],
                  },
                  scopeSpans: [
                    {
                      scope: { name: 'kemdicode' },
                      spans: spans.map((s) => this.spanToOtlp(s)),
                    },
                  ],
                },
              ],
            }),
          });
        } catch {
          /* ignore export errors */
        }
      },
    };

    setInterval(() => this.flush(), this.config.exportInterval);
  }

  private spanToOtlp(span: Span): object {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      startTimeUnixNano: span.startTime * 1_000_000,
      endTimeUnixNano: (span.endTime || Date.now()) * 1_000_000,
      status: { code: span.status === 'ok' ? 0 : span.status === 'error' ? 2 : 1 },
      kind: this.kindToOtlp(span.kind),
      attributes: Object.entries(span.attributes).map(([k, v]) => ({
        key: k,
        value: { stringValue: String(v) },
      })),
      events: span.events.map((e) => ({
        name: e.name,
        timeUnixNano: e.timestamp * 1_000_000,
      })),
    };
  }

  private kindToOtlp(kind: SpanKind): number {
    const map: Record<SpanKind, number> = {
      internal: 0,
      server: 1,
      client: 2,
      producer: 3,
      consumer: 4,
    };
    return map[kind] ?? 0;
  }

  startSpan(
    name: string,
    options?: {
      kind?: SpanKind;
      attributes?: SpanAttributes;
      parentContext?: SpanContext;
    }
  ): SpanImpl {
    const parentContext = options?.parentContext || this.context;
    const spanId = this.generateId();

    const context: SpanContext = {
      traceId: parentContext.traceId,
      spanId,
      parentSpanId: parentContext.spanId,
      traceFlags: 1,
    };

    const span = new SpanImpl(name, context, options?.kind || 'internal', options?.attributes);

    if (this.config.enabled && this.sampler()) {
      this.spans.push(span);
    }

    return span;
  }

  withSpan<T>(
    name: string,
    fn: (span: SpanImpl) => Promise<T>,
    options?: { kind?: SpanKind; attributes?: SpanAttributes; parentContext?: SpanContext }
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return result.finally(() => span.end());
      }
      span.end();
      return result;
    } catch (error) {
      span.setStatus('error', String(error));
      span.end();
      throw error;
    }
  }

  getCurrentContext(): SpanContext {
    return { ...this.context };
  }

  setContext(context: SpanContext): void {
    this.context = context;
  }

  injectContext(carrier: Record<string, string>): Record<string, string> {
    carrier['traceparent'] = `00-${this.context.traceId}-${this.context.spanId}-01`;
    return carrier;
  }

  extractContext(carrier: Record<string, string>): SpanContext | null {
    const traceparent = carrier['traceparent'];
    if (!traceparent) return null;

    const match = traceparent.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-01$/);
    if (!match) return null;

    return {
      traceId: match[1],
      spanId: match[2],
      traceFlags: 1,
    };
  }

  async flush(): Promise<void> {
    if (!this.exporter || this.spans.length === 0) return;

    const toExport = this.spans.filter((s) => s.isEnded());
    this.spans = this.spans.filter((s) => !s.isEnded());

    if (toExport.length > 0) {
      await this.exporter.export(toExport);
    }
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  getStats(): { activeSpans: number; totalSpans: number } {
    return {
      activeSpans: this.spans.filter((s) => !s.isEnded()).length,
      totalSpans: this.spans.length,
    };
  }
}

export const tracer = new Tracer({
  serviceName: 'kemdicode-mcp',
  enabled: true,
  sampleRate: 1.0,
});

export function createTracer(config?: Partial<TracerConfig>): Tracer {
  return new Tracer(config);
}
