# Troubleshooting

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
  node dist/cli.js server mcp --db .relay/team.db
  ```

- In Claude Code, check `/mcp` or start with `--mcp-config`.
- In Codex, confirm the trusted `config.toml` has the expected `mcp_servers.<id>.command` and `args`.

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
node dist/cli.js member list --db .relay/team.db --token <admin-token> --workspace <workspace-id>
node dist/cli.js status <packet-id> --db .relay/team.db --token <sender-token>
```

## Hydration Is Rejected

Hydration requires explicit review and a human approval token:

- Ask/share packets: recipient must `view`, then `accept`, then generate an `approval-token --approval-secret <secret> --action hydrate`, then `hydrate`.
- Reply packets: sender must `view`, then generate an `approval-token --approval-secret <secret> --action hydrate`, then `hydrate`.

Invalid transitions return `INVALID_STATE_TRANSITION`.

Missing, expired, reused, or wrong-action approval tokens return `FORBIDDEN`.

If `/packets/:packetId/approval-token` returns `FORBIDDEN` with an approval secret message, use the CLI `approval-token` command with the approval secret returned during setup/acceptance. Static local-renderer headers are ignored.

```bash
node dist/cli.js approval-token <packet-id> --db .relay/team.db --token <member-token> --approval-secret <approval-secret> --action send
```

For audit/debugging:

```bash
node dist/cli.js history --db .relay/team.db --token <member-token> --workspace <workspace-id> --filter open
node dist/cli.js audit --db .relay/team.db --token <admin-token> --workspace <workspace-id>
```

If an approval secret leaks, rotate it and update your local secret manager:

```bash
node dist/cli.js member rotate-approval-secret --db .relay/team.db --token <member-token> --approval-secret <current-approval-secret> --json
```

The old approval secret stops working immediately, and unconsumed approval tokens already minted by that member are invalidated. If you no longer have the current approval secret, ask a workspace admin to revoke and reinvite the member.

## Packet Needs More Evidence

Recipients can ask for clarification before hydration:

```bash
node dist/cli.js clarify <packet-id> --db .relay/team.db --token <recipient-token> --question "Can you include the failing assertion?" --requested-evidence "test failure"
```

## Watcher Prints Nothing

The watcher only reports new packet ids once per process. Check `inbox` directly:

```bash
node dist/cli.js inbox --db .relay/team.db --token <token> --workspace <workspace-id>
```

## Desktop Or Webhook Notifications Do Not Fire

Desktop notifications are best-effort from the local watcher process:

- macOS uses `osascript`.
- Linux uses `notify-send`; install your desktop notification package if it is missing.
- Windows uses a PowerShell tray notification.

Webhook notifications require a reachable endpoint that accepts JSON POSTs:

```bash
node dist/cli.js watch --db .relay/team.db --token <token> --workspace <workspace-id> --webhook-url https://hooks.example.test/relay --once
```

If the adapter fails, `watch` still prints the terminal notification and writes an adapter warning to stderr.
