# Security Policy

Handoff moves sensitive engineering context between coding agents, so security reports are welcome and should be handled carefully.

## Supported Versions

The latest published npm version and the `main` branch receive security fixes.

## Reporting A Vulnerability

Please do not post exploit details, approval secrets, member tokens, database files, or sensitive packet contents in a public issue.

Preferred report path:

1. Use GitHub's private vulnerability reporting or Security Advisory flow for this repository when available.
2. If private reporting is unavailable, open a minimal public issue asking for a private contact path. Do not include exploit details or secrets in that issue.

Include, when safe:

- affected version or commit
- whether the issue affects CLI, MCP, API, storage, setup, notifications, or docs
- minimal reproduction steps without real credentials or packet bodies
- expected impact
- whether a secret, member token, approval secret, or `.relay/*.db` file may have been exposed

## Security Model Summary

- Sender approval is required before ask/share packets leave the sender.
- Recipient approval is required before ask/share packets hydrate.
- Reply approval is required before recipient-agent output returns to the sender.
- Approval tokens are short-lived and scoped to member, packet, and action.
- Approval secrets are profile-backed and should not appear in MCP schemas, prompts, committed files, or screenshots.
- Secret-looking content blocks packet approval by default.
- Raw transcripts are not captured or shared by default.
- Packet access is enforced in the service/storage layer.

Full model: [docs/security-privacy.md](docs/security-privacy.md).

## Handling Secrets

If a member token or approval secret is exposed:

```bash
npx -y handoff-relay member rotate-approval-secret \
  --token <member-token> \
  --approval-secret <current-approval-secret> \
  --json
npx -y handoff-relay member rotate-token --token <member-token> --json
```

If a local database is exposed, treat all packet bodies, token hashes, audit metadata, and hydration receipts in that database as sensitive.
