# Troubleshooting

## Start With Doctor

Run:

```bash
npx -y handoff-relay doctor
npx -y handoff-relay doctor --json
```

Doctor checks the Handoff home directory, active profile, credential file permissions, member token, approval secret, server reachability, workspace access, and the profile-backed MCP command.

If the profile is missing and you are hosting a workspace for teammates, run:

```bash
npx -y handoff-relay start --lan
npx -y handoff-relay invite alice
```

If you are joining someone else's workspace, ask them for the invite command and run:

```bash
npx -y handoff-relay join <invite-link> --install-mcp codex
npx -y handoff-relay watch --desktop-notifications
```

Plain `start` is only the right recovery path for local demos, CI smoke tests, or two profiles on one machine.

If `doctor` reports `WARN` for `mcp_config`, add Handoff to your MCP client. For Codex or Cursor, Handoff can write the common global config while hosting or joining:

```bash
npx -y handoff-relay start --lan --install-mcp codex
npx -y handoff-relay start --lan --install-mcp cursor
npx -y handoff-relay join <invite-link> --install-mcp codex
npx -y handoff-relay join <invite-link> --install-mcp cursor
```

For Claude Code or another MCP client, add the printed profile-backed command:

```bash
npx -y handoff-relay server mcp --profile default
```

If a teammate cannot join from another machine, restart the host in LAN mode and send a fresh invite:

```bash
npx -y handoff-relay start --lan
npx -y handoff-relay invite alice
```

## `better-sqlite3` Cannot Find Native Bindings

Run:

```bash
pnpm rebuild better-sqlite3 esbuild
```

This package includes `pnpm-workspace.yaml` with `onlyBuiltDependencies` for `better-sqlite3` and `esbuild`. If your pnpm policy still blocks builds, approve those packages for this checkout.

## MCP Server Starts But Tools Do Not Appear

- Confirm `pnpm build` produced `dist/cli.js`.
- Run the command directly:

  ```bash
  npx -y handoff-relay server mcp --profile default
  ```

- In Claude Code, check `/mcp` or start with `--mcp-config`.
- In Codex, confirm the trusted `config.toml` has the expected `mcp_servers.<id>.command` and `args`.
- Confirm the MCP args use `--profile default` unless you intentionally need `--explicit-auth`.

## Redaction Blocks A Packet

Handoff blocks secret-looking content by default. Remove the evidence excerpt, replace it with a hash or summary, then create a new draft.

Common causes:

- `API_KEY=...`
- `TOKEN=...`
- Private key PEM blocks.
- `postgres://user:pass@host/db`
- Evidence marked `secret_detected` or `restricted`.

## Recipient Cannot See A Packet

Check:

- The recipient handle is in the same workspace.
- The member is active, not revoked.
- The packet was approved and delivered.
- The token belongs to the intended workspace.

Use:

```bash
npx -y handoff-relay member list --db .relay/team.db --token <admin-token> --workspace <workspace-id>
npx -y handoff-relay status <packet-id> --db .relay/team.db --token <sender-token>
```

## Hydration Or Approval Is Rejected

Strict mode requires explicit review and a human approval token:

- Ask/share packets: recipient should `relay_review`, generate an `approval-token --action hydrate`, then `relay_hydrate_approved`.
- Reply packets: sender should `relay_review`, generate an `approval-token --action hydrate`, then `relay_hydrate_approved`.

Invalid transitions return `INVALID_STATE_TRANSITION`.

Missing, expired, reused, or wrong-action approval tokens return `FORBIDDEN`.

If you intended to use agent-confirmed approvals, confirm your MCP command includes profile mode and `--agent-approvals`:

```bash
npx -y handoff-relay server mcp --profile default --agent-approvals
```

Agent-confirmed approvals are not available in explicit-auth MCP mode or when the local profile credentials are missing.

If `/packets/:packetId/approval-token` returns `FORBIDDEN` with an approval secret message, use the CLI `approval-token` command with the approval secret returned during setup/acceptance. Static local-renderer headers are ignored.

In profile-backed mode:

```bash
npx -y handoff-relay approval-token <packet-id> --action send
```

In explicit advanced mode:

```bash
npx -y handoff-relay approval-token <packet-id> --db .relay/team.db --token <member-token> --approval-secret <approval-secret> --action send
```

For audit/debugging:

```bash
npx -y handoff-relay history --db .relay/team.db --token <member-token> --workspace <workspace-id> --filter open
npx -y handoff-relay audit --db .relay/team.db --token <admin-token> --workspace <workspace-id>
```

If an approval secret leaks, rotate it and update your local secret manager:

```bash
npx -y handoff-relay member rotate-approval-secret --db .relay/team.db --token <member-token> --approval-secret <current-approval-secret> --json
```

The old approval secret stops working immediately, and unconsumed approval tokens already minted by that member are invalidated. If a teammate leaves or is removed, their unconsumed approval tokens are invalidated too.

## Packet Needs More Evidence

Recipients can ask for clarification before hydration:

```bash
npx -y handoff-relay clarify <packet-id> --db .relay/team.db --token <recipient-token> --question "Can you include the failing assertion?" --requested-evidence "test failure"
```

## Watcher Prints Nothing

The watcher reads the durable notification queue and acknowledges a notification after it is delivered locally. Check `inbox` directly:

```bash
npx -y handoff-relay inbox --db .relay/team.db --token <token> --workspace <workspace-id>
```

## Desktop Or Webhook Notifications Do Not Fire

Desktop notifications are best-effort from the local watcher process:

- macOS uses `osascript`.
- Linux uses `notify-send`; install your desktop notification package if it is missing.
- Windows uses a PowerShell tray notification.

Webhook notifications require a reachable endpoint that accepts JSON POSTs:

```bash
npx -y handoff-relay watch --db .relay/team.db --token <token> --workspace <workspace-id> --webhook-url https://hooks.example.test/relay --once
```

If the adapter fails, `watch` still prints the terminal notification and writes an adapter warning to stderr.
