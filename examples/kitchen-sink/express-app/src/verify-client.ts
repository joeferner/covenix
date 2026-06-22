import assert from 'node:assert/strict';
// The generated standalone client (written next to this file by `npm run client`).
import { createClient, ZodecClientError } from './api.gen.js';

// Exercises the *generated* client against the running kitchen-sink server — the
// real proof that codegen output works end to end (typed calls, path params,
// query, JSON + the throw / .raw response forms, and a @Security route).
const baseUrl = process.argv[2] ?? 'http://localhost:3111';
const ok = (msg: string): void => console.log(`✓ ${msg}`);

async function main(): Promise<void> {
  const api = createClient({ baseUrl });

  const health = await api.health.check();
  assert.equal(health.status, 'ok');
  ok('health.check() → { status: "ok" }');

  // @Sse route → a typed async iterable of events. The server sends a few pings
  // then ends; we also cap consumption so this can never hang on an open stream
  // (breaking cancels the reader and closes the connection).
  const events: { status: string }[] = [];
  for await (const event of await api.health.events()) {
    events.push(event);
    if (events.length >= 3) break;
  }
  assert.ok(events.length > 0 && events[0]?.status === 'ok');
  ok(`health.events() streamed ${events.length} SSE event(s) as an async iterable`);

  const created = await api.users.create({
    body: { username: 'clientuser', email: 'clientuser@example.com' },
    // x-request-id is a documented @Headers param (validated as a UUID server-side).
    headers: { 'x-request-id': crypto.randomUUID() },
  });
  assert.ok(created.id);
  ok(`users.create({ body, x-request-id }) → User (${created.id})`);

  // A malformed documented header is rejected with 400 before the body is touched.
  await assert.rejects(
    api.users.create({
      body: { username: 'hdr', email: 'hdr@example.com' },
      headers: { 'x-request-id': 'not-a-uuid' },
    }),
    (err: unknown) => err instanceof ZodecClientError && err.status === 400,
  );
  ok('users.create({ x-request-id: invalid }) → ZodecClientError(400) (@Headers validation)');

  const fetched = await api.users.get({ params: { id: created.id } });
  assert.equal(fetched.username, 'clientuser');
  ok('users.get({ params }) → User (path param interpolated)');

  const list = await api.users.list({ query: { page: 1, limit: 5 } });
  assert.ok(Array.isArray(list.items) && typeof list.total === 'number');
  ok('users.list({ query }) → UserList (query serialized)');

  // .raw() exposes response headers as a standard Headers object.
  const listRaw = await api.users.list.raw({ query: { page: 1, limit: 5 } });
  assert.equal(listRaw.status, 200);
  assert.equal(listRaw.headers.get('x-total-count'), String(list.total));
  ok('users.list.raw() → reads the X-Total-Count response header');

  const missing = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    api.users.get({ params: { id: missing } }),
    (err: unknown) => err instanceof ZodecClientError && err.status === 404,
  );
  ok('users.get(missing) throws ZodecClientError(404)');

  const raw = await api.users.get.raw({ params: { id: missing } });
  assert.equal(raw.status, 404);
  ok('users.get.raw(missing) → { status: 404, body } (no throw)');

  // Multipart upload (File → FormData) then a binary file download as a Blob.
  const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG sig
  const upload = await api.users.uploadAvatar({
    params: { id: created.id },
    body: { avatar: new File([avatarBytes], 'avatar.png', { type: 'image/png' }) },
  });
  assert.equal(upload.contentType, 'image/png');
  ok('users.uploadAvatar({ multipart }) → UploadResult');

  const full = await api.users.getAvatar({ params: { id: created.id } });
  assert.equal(full.size, avatarBytes.length);
  ok(`users.getAvatar() → Blob (${full.size}-byte full download)`);

  // HTTP Range via a per-call header → partial content (the avatar/raw route is a
  // RangeFileResponse). 206 is a 2xx, so the default form returns the sliced Blob.
  const partial = await api.users.getAvatar({
    params: { id: created.id },
    headers: { Range: 'bytes=0-2' },
  });
  assert.equal(partial.size, 3);
  ok('users.getAvatar({ Range: "bytes=0-2" }) → 3-byte partial (HTTP Range honored)');

  const token = await api.auth.login({
    body: { username: 'clientuser', password: 'password123' },
  });
  assert.ok(token.token.length > 0);
  ok('auth.login({ body }) → Token');

  // A second client with a lazily-resolved bearer header hits the @Security route.
  const authed = createClient({
    baseUrl,
    headers: { authorization: () => `Bearer ${token.token}` },
  });
  const me = await authed.auth.me();
  assert.equal(me.username, 'clientuser');
  ok('auth.me() with default bearer header → User (security route)');

  // @Cookies/@CookieParam: send a `sid` cookie via the generic headers escape hatch
  // (cookie-parser populates req.cookies server-side; see main.ts).
  const withCookie = await api.auth.session({ headers: { cookie: 'sid=abc123' } });
  assert.equal(withCookie.authenticated, true);
  const noCookie = await api.auth.session();
  assert.equal(noCookie.authenticated, false);
  ok('auth.session() reads the `sid` cookie via @Cookies/@CookieParam');

  console.log('client exercised the live server successfully');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
