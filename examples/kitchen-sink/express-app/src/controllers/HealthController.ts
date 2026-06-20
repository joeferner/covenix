import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { Route, Tags, Get, Returns, Summary, Use, Req, Res, Header } from 'zodec';

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

  // Escape hatch: no @Returns, no schema — grab the raw Express objects and
  // write the response yourself. zodec stays out of the way.
  @Get('raw')
  @Summary('Plain-text ping, written straight to the Express response')
  public rawPing(@Req() req: Request, @Res() res: Response): void {
    void req;
    res.status(200).type('text/plain').send('pong');
  }
}
