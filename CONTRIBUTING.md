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

- Node.js 20+
- PostgreSQL 15+
- Docker (for sandbox features)

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/portal.git
cd portal

# Install dependencies
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Set up environment
cp backend/.env.example backend/.env
# Edit backend/.env with your database URL and settings

# Run database migrations
cd backend && npx prisma migrate dev && cd ..

# Start development servers
cd backend && npm run dev &
cd frontend && npm run dev &
```

The frontend runs on `http://localhost:5173` and proxies API calls to the backend on port 4001.

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

Check the [Roadmap](README.md#-roadmap) for areas where help is welcome. Issues tagged `good first issue` are great starting points.

## Questions?

Open an [issue](https://github.com/BridgesLLM-ai/portal/issues) or email support@bridgesllm.com.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
