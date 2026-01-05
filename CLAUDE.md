# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Immich is a self-hosted photo and video management solution. This is a monorepo containing:
- **server** - NestJS backend (TypeScript)
- **web** - SvelteKit frontend (TypeScript)
- **mobile** - Flutter app (Dart)
- **machine-learning** - Python ML service (CLIP embeddings, facial recognition)
- **cli** - Command-line interface (@immich/cli)
- **open-api/typescript-sdk** - Auto-generated TypeScript SDK (@immich/sdk)
- **docs** - Docusaurus documentation site
- **e2e** - End-to-end tests (Vitest + Playwright)

## Development Commands

### Setup and Development
```bash
# Install dependencies (pnpm 10.24.0+ required)
make install-all          # Install all packages except docs

# Start full development environment (requires Docker)
make dev                  # Runs docker-compose.dev.yml

# Start individual components for development
make setup-server-dev     # Install server dependencies
make setup-web-dev        # Build SDK, install web dependencies
make dev-docs             # Start documentation site (port 3005)
```

### Building
```bash
make build-server         # Build server
make build-web            # Build web (requires SDK)
make build-cli            # Build CLI (requires SDK)
make build-sdk            # Build TypeScript SDK
make build-all            # Build all components
```

### Testing
```bash
make test-server          # Run server unit tests
make test-web             # Run web unit tests
make test-cli             # Run CLI tests
make test-e2e             # Run e2e tests (requires Docker)
make test-medium          # Run server medium tests in Docker
make test-all             # Run all tests
```

### Code Quality
```bash
make lint-all             # Lint and fix all packages
make format-all           # Format all packages
make check-all            # Type check all packages
make hygiene-all          # Run audit, format, check, and lint

# Per-package (replace % with: server, web, cli, sdk, e2e, docs)
make lint-%
make format-%
make check-%
```

### Database and API
```bash
make sql                  # Sync SQL schema (pnpm --filter immich run sync:sql)
make open-api             # Regenerate OpenAPI specs and clients
make open-api-dart        # Regenerate Dart client only
make open-api-typescript  # Regenerate TypeScript SDK only
```

## Architecture

### Server (NestJS)
- Uses Kysely for SQL queries (not TypeORM for new code)
- BullMQ for job queues with Redis
- PostgreSQL with vector extensions for ML embeddings
- Structure: `controllers/` (HTTP), `services/` (business logic), `repositories/` (data access), `dtos/` (validation)

### Web (SvelteKit)
- Svelte 5 with runes
- TailwindCSS 4 for styling
- Socket.io for real-time updates
- Depends on @immich/sdk for API calls

### Mobile (Flutter)
- Isar Database for local storage
- Riverpod for state management
- MVVM-inspired architecture: models, providers, services, ui, views
- Uses FVM for Flutter version management
- Run `make translation` from mobile/ after adding i18n keys

### Machine Learning (Python)
- Uses `uv` for dependency management
- Run `uv sync --extra cpu` (or cuda/rocm/openvino for acceleration)
- Locust for load testing

## Key Development Notes

- The SDK must be built before web or cli: `make build-sdk`
- Docker development environment exposes: server (2283), web (3000), ML (3003), postgres (5432)
- Server debug port: 9230
- Web hot reload port: 24678
- Use `make clean` to reset all node_modules and build artifacts
