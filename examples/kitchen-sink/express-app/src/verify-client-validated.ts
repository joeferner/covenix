import assert from 'node:assert/strict';
// The generated *validating* client (written by `npm run client -- … --validate`).
// It imports zod and parses requests/responses at runtime.
import { createClient, ZodecClientValidationError } from './api.validated.gen.js';

// Exercises the validating client against the running server: proves real server
// responses parse cleanly against the regenerated schemas, and that request-input
// validation fires before the network.
const baseUrl = process.argv[2] ?? 'http://localhost:3111';
const ok = (msg: string): void => console.log(`✓ ${msg}`);

async function main(): Promise<void> {
  const api = createClient({ baseUrl });

  // Each call parses the server's response through the regenerated Zod schema; a
  // drift would throw ZodecClientValidationError. Reaching the assertions proves
  // the responses conform.
  // Send a real Date in the request body; it round-trips back as a real Date.
  const lastSeenAt = new Date('2020-06-15T10:00:00.000Z');
  const created = await api.users.create({
    body: { username: 'valclient', email: 'valclient@example.com', lastSeenAt },
  });
  assert.equal(typeof created.id, 'string');
  assert.ok(
    created.lastSeenAt instanceof Date &&
      created.lastSeenAt.toISOString() === lastSeenAt.toISOString(),
  );
  ok('users.create({ lastSeenAt: Date }) → response revives z.date() to a Date');

  const fetched = await api.users.get({ params: { id: created.id } });
  assert.equal(fetched.id, created.id);
  ok('users.get() → response validated');

  const list = await api.users.list({ query: { page: 1, limit: 5 } });
  assert.ok(Array.isArray(list.items) && typeof list.total === 'number');
  ok('users.list() → response validated');

  // Request-input validation fires *before* the network: an invalid body throws
  // a ZodecClientValidationError (phase 'request') rather than hitting the server.
  await assert.rejects(
    api.users.create({ body: { username: 'x', email: 'nope' } }),
    (err: unknown) => err instanceof ZodecClientValidationError && err.phase === 'request',
  );
  ok('users.create(invalid) → ZodecClientValidationError (request, no network)');

  console.log('validating client exercised the live server successfully');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
