import express from 'express';
import { zodecErrorHandler } from 'zodec';
import { api } from './api.js';

const app = express();
app.use(express.json());

// Wire every registered controller's routes + validation middleware onto Express.
api.mount(app);

// Same instance generates the spec from the controllers it already holds.
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));

// zodec never sends an error response itself — failed validation and thrown
// http-errors flow through Express. This convenience handler renders the
// standard { status, errors } shape; swap it for your own to control the output.
app.use(zodecErrorHandler());

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Kitchen Sink API listening on http://localhost:${port}`);
});
