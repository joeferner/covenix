/** Per-event SSE framing fields (everything except the payload). */
export interface SseEventInit {
  /**
   * Event name. The browser dispatches it via `addEventListener(name, …)`;
   * without it the event lands in the generic `onmessage` handler.
   */
  event?: string;
  /**
   * Event id. The browser echoes the last one as `Last-Event-ID` on reconnect,
   * letting the server resume the stream.
   */
  id?: string | number;
  /** Reconnection delay hint (ms) the client should wait after a drop. */
  retry?: number;
}

/**
 * A Server-Sent Event with explicit framing. Yield one from an `@Sse` handler
 * to set the `event`/`id`/`retry` fields; yield a plain value to frame it as a
 * `data:` line with no framing metadata. The `data` is validated against the
 * `@Sse` schema, if any.
 *
 * @example
 * ```ts
 * yield token;                                   // data: <json>
 * yield new SseEvent(result, { event: 'done' }); // event: done\ndata: <json>
 * ```
 */
export class SseEvent<T = unknown> {
  /** The event payload (validated against the `@Sse` schema). */
  public readonly data: T;
  /** Event name, if set. */
  public readonly event: string | undefined;
  /** Event id, if set. */
  public readonly id: string | number | undefined;
  /** Reconnection delay hint (ms), if set. */
  public readonly retry: number | undefined;

  public constructor(data: T, init: SseEventInit = {}) {
    this.data = data;
    this.event = init.event;
    this.id = init.id;
    this.retry = init.retry;
  }
}
