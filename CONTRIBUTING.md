# Contributing

Thanks for helping make Handoff better. The project is small on purpose: keep changes aligned with human-approved context packets between coding agents.

## Product Boundaries

Good contributions strengthen one of these areas:

- Relay Packet quality, reviewability, redaction, hydration, or auditability.
- MCP-native agent workflows for Codex, Claude Code, Cursor, or generic MCP clients.
- Local-first setup, self-hosting, profile health, notifications, and recovery.
- Clear docs, examples, launch assets, or package verification.

Avoid contributions that turn Handoff into:

- agent Slack or general chat
- passive shared memory
- hosted transcript ingestion
- autonomous agent-to-agent exchange without human approval gates
- public A2A protocol support

## Development Setup

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

Useful commands:

```bash
pnpm cli -- --help
pnpm demo
pnpm vitest run tests/setup-profile.test.ts
npm pack --dry-run
```

## Pull Request Checklist

Before opening a PR:

- Run the narrow tests for the files you touched.
- Run `pnpm check`.
- Run `pnpm build` if package/runtime output may change.
- Run `npm pack --dry-run` when README, package metadata, docs, examples, assets, or build output changes.
- Keep `README.md` and `scripts/npm-readme.md` aligned when public setup or product positioning changes.
- Keep approval, redaction, authorization, and audit behavior covered by tests when behavior changes.
- Do not commit local `.relay/*.db` files, credentials, approval secrets, packet dumps with sensitive content, or internal scratch plans.

## Testing Guidance

Use integration-style tests for changes that cross layers. A tool-level test that reaches the service/storage layer is more valuable than only mocking the changed function.

For setup/profile work, smoke the real user path in temporary homes:

```bash
HANDOFF_HOME="$(mktemp -d)" npx -y handoff-relay start --lan --install-mcp codex --invite alice
HANDOFF_HOME="$(mktemp -d)" npx -y handoff-relay doctor --json
```

For docs/package work, verify what ships:

```bash
npm pack --dry-run
```

## Release Notes

Release-facing changes should explain what is now possible or safer for users. Avoid describing only which files changed.
