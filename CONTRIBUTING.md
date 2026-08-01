# Contributing to BridgesLLM Portal

Thanks for your interest in contributing! This guide will help you get started.

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/BridgesLLM-ai/portal/issues) first
2. Open a new issue using the **Bug Report** template
3. Include: what you expected, what happened, steps to reproduce, and your environment (OS, Node version, portal version)

### Suggesting Features

1. Open an issue using the **Feature Request** template
2. Describe the problem you're solving, not just the solution you want
3. We'll discuss it before any code is written

### Pull Requests

1. **Open an issue first** for significant changes — let's agree on the approach before you write code
2. Fork the repo
3. Create a feature branch from `main`: `git checkout -b feature/your-feature`
4. Make your changes
5. Test locally (see Development Setup below)
6. Commit with a clear message: `git commit -m "feat: add widget support"`
7. Push and open a PR against `main`

Small fixes (typos, docs, one-liners) can skip the issue step.

## Development Setup

### Prerequisites

- Node.js 22.22.3+ on the 22.x line, 24.15.0+ on the 24.x line, or 25.9.0+ (Node 22 LTS recommended)
- PostgreSQL 15+
- Docker (optional, for local PostgreSQL and sandbox features)

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/portal.git
cd portal

# Install dependencies
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Choose the password used by the local Compose database
export POSTGRES_PASSWORD='choose-a-local-development-password'
```

Create `backend/.env` (it is ignored by Git) with local-only values. Generate
the two JWT values separately with `openssl rand -hex 32`; do not reuse these
development secrets on an installed Portal:

```dotenv
DATABASE_URL=postgresql://bridges:choose-a-local-development-password@127.0.0.1:5432/bridgesllm_portal
PORT=4001
HOST=127.0.0.1
CORS_ORIGIN=http://localhost:5173
JWT_SECRET=replace-with-a-random-64-character-hex-value
JWT_REFRESH_SECRET=replace-with-another-random-64-character-hex-value
```

Start the local database (or use an existing PostgreSQL 15+ server), then
finish setup and start the development servers:

```bash
# The POSTGRES_PASSWORD export from above must still be in this shell
docker compose up -d postgres

# Run database migrations
cd backend && npx prisma migrate dev && cd ..

# Start development servers
cd backend && npm run dev &
cd frontend && npm run dev &
```

The frontend runs on `http://localhost:5173` and proxies API calls to the backend on port 4001.

The root `docker-compose.yml` models the host-integrated Linux deployment and
expects its listed host paths and companion services to exist. For ordinary
source development, use only its `postgres` service as shown above; use the
installer for a complete Portal host.

## Code Style

- **TypeScript** for all new code (backend and frontend)
- Use existing patterns — look at similar files before creating new ones
- Meaningful variable names over comments
- No `any` types unless absolutely necessary (and explain why)

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `chore:` — maintenance tasks

## What We're Looking For

Check the [Roadmap](README.md#roadmap) for areas where help is welcome. Issues tagged `good first issue` are great starting points.

## Questions?

Open an [issue](https://github.com/BridgesLLM-ai/portal/issues) or email support@bridgesllm.com.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
