# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the Vue 3 client: page components in `src/views/`, streaming and room logic in `src/composables/`, and global CSS at the directory root.
- `server/app.js` is the Express and WebSocket backend. It serves the built client, stores room/NATMap state, handles uploads, and proxies SRS WHIP/WHEP requests.
- `test/app.test.js` contains backend integration tests.
- `scripts/` holds router-side utilities; `deploy/`, `compose.yaml`, `Dockerfile`, and `srs.drivod.top.conf` hold deployment configuration.
- `dist/`, `node_modules/`, and runtime `.data/` content are generated and should not be edited or committed.

## Build, Test, and Development Commands

Use Node.js 18 or newer and install exact dependencies with `npm ci`.

- `npm run dev` starts the API on port 21080 and Vite on port 5173 with live reload.
- `npm run build` creates the production client in `dist/`.
- `npm test` builds first, then runs all tests with `node --test`.
- `npm run check` performs a syntax check of `server/app.js`.
- `npm start` serves the built application through the production backend.

## Coding Style & Naming Conventions

Use two-space indentation. Frontend modules omit semicolons; the CommonJS server and tests use semicolons and `'use strict'`. Name Vue components in PascalCase (`PublishView.vue`), composables with a `use` prefix (`useWhepPlayer.js`), variables/functions in camelCase, and constants in UPPER_SNAKE_CASE. No formatter or linter is configured, so preserve nearby style and keep diffs focused.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Add behavior-focused tests to `test/app.test.js`, such as `test('persists and returns NATMap state', ...)`. Use temporary directories and ephemeral ports, and close servers and WebSockets during cleanup. Run `npm test` before every pull request; no coverage threshold is enforced.

## Commit & Pull Request Guidelines

Recent history favors concise Conventional Commit subjects: `feat: add room management` or `fix: prevent duplicate viewer names`. Keep commits scoped. Pull requests should explain user and deployment impact, list validation commands, link issues, and include screenshots for UI changes. Call out changes to environment variables, proxy routes, ports, SRS/NATMap behavior, or data formats.

## Security & Configuration

Copy `.env.example` values into deployment-specific configuration; never commit credentials, webhook tokens, uploaded media, or production state. Validate proxy and Nginx changes carefully because signaling is proxied while UDP media connects directly through the NATMap endpoint.
