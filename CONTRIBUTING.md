# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Before you open a PR

```bash
cd apps/server
npm ci
npx tsc -p tsconfig.json --noEmit
npm test                  # unit + router tests — no database, no Redis, no network

cd ../apps/pwa
npm ci
npx tsc --noEmit
npm run build
```

CI runs exactly these, plus the integration suite against a real PostgreSQL, plus
a container image build. Every check must be green before a PR can be merged.

## Where things belong

**Routing behaviour** goes in `apps/server/src/router/`. It depends only on four
small interfaces — `Store`, `DedupStore`, `Queue`, `Clock` — so it can be tested
against in-memory implementations with no infrastructure at all. New routing
logic should come with tests of that kind.

**Anything that changes SQL semantics** needs an integration test in
`apps/server/src/db/__tests__/`. A `GROUP BY`, a multi-row `UPDATE`, an `ON
DELETE` rule, a unique index — the type checker proves nothing about any of them,
and we have shipped bugs in all four. Those tests skip themselves unless
`TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/db npm run test:integration
```

## Things this project will not take

- **Dependencies with native addons.** The runtime image is deliberately
  compiler-free: password hashing uses Node's built-in `scrypt`, and SMS
  providers speak HTTP directly rather than through vendor SDKs. That is what
  keeps the image plain Alpine and the multi-arch build honest.
- **Dependencies that drag in deprecated transitives.** Both apps install with
  zero deprecation warnings today. Keep it that way.
- **Silent failure.** This is an alerting system: its worst outcome is not an
  error, it is *quiet*. If something cannot be done, say so — to the user, in the
  UI, in the log. A button that does nothing is worse than no button, and a
  message claiming a valve closed when we only know a webhook returned 200 is
  worse still.

## Safety-critical areas

Two parts of the codebase can act on the physical world or grant access. Changes
there get read more carefully, and are expected to come with tests for what must
*never* happen, not merely what should:

- **`router/escalation.ts`** — can close a valve unattended. Acknowledgement must
  cancel it; a retried queue job must not run it twice; the report it produces
  must never start another escalation.
- **`lib/auth.ts`, `lib/session.ts`, `lib/webhook.ts`** — the authentication
  boundary and the signed outbound webhook.
