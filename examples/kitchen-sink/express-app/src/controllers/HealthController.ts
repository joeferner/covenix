import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  Route,
  Tags,
  Get,
  Returns,
  Summary,
  Sse,
  Use,
  Req,
  Res,
  createParamDecorator,
  HttpResponse,
} from 'avero';

const HealthSchema = z
  .object({
    status: z.literal('ok'),
    uptimeMs: z.number().int(),
  })
  .meta({ id: 'Health' });

// Plain Express middleware — runs before every route in this controller via the
// class-level @Use below. Stamps a header so callers can tell avero served it.
const stampSource: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Health-Source', 'avero');
  next();
};

// A custom parameter decorator built with createParamDecorator. The resolver runs
// per request with `{ req, res }` (and any `data` you pass) and may be sync or
// async; its value is injected as a handler argument. @Principal() is built the
// same way.
const ClientIp = createParamDecorator(({ req }) => req.ip ?? 'unknown');

@Route('health')
@Tags('Health')
@Use(stampSource)
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  @Summary('Liveness probe')
  @Returns(200, HealthSchema)
  public check(@ClientIp() ip: string): HttpResponse<z.infer<typeof HealthSchema>> {
    // The body is still validated/serialized by HealthSchema; X-Client-IP is an
    // undeclared header (not in @Returns), so it's allowed but stays out of the spec.
    return new HttpResponse(
      { status: 'ok', uptimeMs: Date.now() - this.startedAt },
      { headers: { 'X-Client-IP': ip } },
    );
  }

  // Server-Sent Events: the handler returns an async generator and avero frames
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
  // write the response yourself. avero stays out of the way.
  @Get('raw')
  @Summary('Plain-text ping, written straight to the Express response')
  public rawPing(@Req() req: Request, @Res() res: Response): void {
    void req;
    res.status(200).type('text/plain').send('pong');
  }
}
