import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { Route, Tags, Get, Returns, Summary, Sse, Use, Req, Res, Header } from 'zodec';

const HealthSchema = z
  .object({
    status: z.literal('ok'),
    uptimeMs: z.number().int(),
  })
  .meta({ id: 'Health' });

// Plain Express middleware — runs before every route in this controller via the
// class-level @Use below. Stamps a header so callers can tell zodec served it.
const stampSource: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Health-Source', 'zodec');
  next();
};

@Route('health')
@Tags('Health')
@Use(stampSource)
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  @Summary('Liveness probe')
  @Returns(200, HealthSchema)
  public check(@Header('user-agent') userAgent: string | undefined): z.infer<typeof HealthSchema> {
    void userAgent;
    return { status: 'ok', uptimeMs: Date.now() - this.startedAt };
  }

  // Server-Sent Events: the handler returns an async generator and zodec frames
  // each yielded value as an SSE event (text/event-stream), validating it against
  // HealthSchema. This one is finite; a real stream (e.g. LLM tokens) would loop,
  // and its `finally` would run when the client disconnects.
  @Get('events')
  @Summary('Stream a few health pings (Server-Sent Events)')
  @Sse(HealthSchema, { keepAlive: 15000 })
  public async *events(): AsyncGenerator<z.infer<typeof HealthSchema>> {
    for (let i = 0; i < 3; i++) {
      yield { status: 'ok', uptimeMs: Date.now() - this.startedAt };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // Escape hatch: no @Returns, no schema — grab the raw Express objects and
  // write the response yourself. zodec stays out of the way.
  @Get('raw')
  @Summary('Plain-text ping, written straight to the Express response')
  public rawPing(@Req() req: Request, @Res() res: Response): void {
    void req;
    res.status(200).type('text/plain').send('pong');
  }
}
