export interface InviteLinkParts {
  inviteToken: string;
  serverUrl: string;
}

export function buildInviteLink(input: { baseUrl: string; inviteToken: string }): string {
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  return `${baseUrl}/invite/${encodeURIComponent(input.inviteToken)}`;
}

export function parseInviteLink(value: string, serverUrl?: string): InviteLinkParts {
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/invite\/([^/]+)$/);
    if (!match) {
      throw new Error('Invite links must use /invite/<invite-token>.');
    }
    return {
      inviteToken: decodeURIComponent(match[1] ?? ''),
      serverUrl: `${parsed.protocol}//${parsed.host}`,
    };
  }
  if (!serverUrl) {
    throw new Error('Raw invite tokens require --server-url.');
  }
  return {
    inviteToken: value,
    serverUrl: serverUrl.replace(/\/+$/, ''),
  };
}
