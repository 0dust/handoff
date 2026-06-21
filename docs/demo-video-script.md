# Short Video Demo Script

Use this script to record a 60-90 second launch demo. It keeps the story narrow: one human-approved context handoff plus one optional reply handoff, with no hosted service.

## Setup

Record a terminal at 120 columns or wider.

```bash
cd handoff
pnpm install
pnpm build
rm -f .relay/demo-video.db .relay/demo-video.db-shm .relay/demo-video.db-wal
```

## Recording Flow

1. Show the product promise:
   "Handoff packages selected agent-session context into a reviewable packet so another coding agent can continue from the right evidence."

2. Run the full local demo:

   ```bash
   npx -y @0dust/handoff demo two-user --db .relay/demo-video.db --json
   ```

3. Point out the shape of the output:
   - workspace-scoped member identities without raw tokens or approval secrets
   - ask status ending in `closed_resolved`
   - reply status ending in `hydrated`
   - share status ending in `archived`
   - audit receipts on the packets

4. Show the watcher notification command users run in a second terminal:

   ```bash
   npx -y @0dust/handoff watch --db .relay/demo-video.db --token <alice-token> --workspace <workspace-id> --once
   ```

5. Show optional native desktop and webhook notification flags:

   ```bash
   npx -y @0dust/handoff watch --db .relay/demo-video.db --token <alice-token> --workspace <workspace-id> --desktop-notifications
   npx -y @0dust/handoff watch --db .relay/demo-video.db --token <alice-token> --workspace <workspace-id> --webhook-url https://hooks.example.test/relay
   ```

## Closing Line

"No passive team memory, no raw transcript dump, no autonomous agent chat. Just structured teammate handoffs with approval, redaction, permissions, and receipts."
