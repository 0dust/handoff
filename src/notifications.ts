import { spawn } from 'node:child_process';
import { platform as currentPlatform } from 'node:os';

export interface NotificationSummary {
  notification_id?: string;
  packet_id: string;
  packet_type: 'ask' | 'share' | 'reply' | 'clarification';
  title: string;
  summary: string;
  sender_handle: string;
  project: string;
}

export interface PollingWatcher {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export type NativeNotificationRunner = (command: string, args: string[]) => Promise<void>;

export interface NotificationDispatcherOptions {
  writeTerminal?: (message: string, summary: NotificationSummary) => void;
  desktop?: boolean;
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  runNativeNotification?: NativeNotificationRunner;
  onError?: (error: Error, channel: 'desktop' | 'webhook') => void;
}

const notificationActions: Record<NotificationSummary['packet_type'], string> = {
  ask: 'is asking for help',
  clarification: 'requested clarification',
  reply: 'replied',
  share: 'shared context',
};

export function formatNotification(summary: NotificationSummary): string {
  const sender = summary.sender_handle.startsWith('@')
    ? summary.sender_handle
    : `@${summary.sender_handle}`;
  const action = notificationActions[summary.packet_type];
  return `${sender} ${action} on ${summary.title} in ${summary.project}. Review packet?`;
}

export function createNotificationDispatcher(input: NotificationDispatcherOptions = {}) {
  return async (message: string, summary: NotificationSummary): Promise<void> => {
    input.writeTerminal?.(message, summary);
    const deliveries: Array<Promise<void>> = [];
    if (input.desktop) {
      deliveries.push(
        sendDesktopNotification(summary, input).catch((error: unknown) => {
          input.onError?.(toError(error), 'desktop');
        }),
      );
    }
    if (input.webhookUrl) {
      deliveries.push(
        sendWebhookNotification(summary, input).catch((error: unknown) => {
          input.onError?.(toError(error), 'webhook');
        }),
      );
    }
    await Promise.all(deliveries);
  };
}

export async function sendDesktopNotification(
  summary: NotificationSummary,
  input: Pick<NotificationDispatcherOptions, 'platform' | 'runNativeNotification'> = {},
): Promise<void> {
  const platform = input.platform ?? currentPlatform();
  const run = input.runNativeNotification ?? defaultRunNativeNotification;
  const title = `Handoff: ${summary.packet_type}`;
  const subtitle = `${senderLabel(summary)} in ${sanitizeNotificationText(summary.project)}`;
  const body = `${sanitizeNotificationText(summary.title)}. ${sanitizeNotificationText(summary.summary)} Open/review in Relay.`;

  if (platform === 'darwin') {
    await run('osascript', [
      '-e',
      `display notification ${appleScriptString(body)} with title ${appleScriptString(title)} subtitle ${appleScriptString(subtitle)}`,
    ]);
    return;
  }
  if (platform === 'linux') {
    await run('notify-send', [title, `${subtitle}\n${body}`]);
    return;
  }
  if (platform === 'win32') {
    await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      windowsBalloonScript(title, body),
    ]);
    return;
  }
  throw new Error(`Desktop notifications are not supported on ${platform}.`);
}

export async function sendWebhookNotification(
  summary: NotificationSummary,
  input: Pick<NotificationDispatcherOptions, 'webhookUrl' | 'webhookHeaders' | 'fetchImpl'>,
): Promise<void> {
  if (!input.webhookUrl) return;
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(input.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(input.webhookHeaders ?? {}),
    },
    body: JSON.stringify(toWebhookPayload(summary)),
  });
  if (!response.ok) {
    throw new Error(`Webhook notification failed with HTTP ${response.status}.`);
  }
}

export function createPollingWatcher(input: {
  ack?: (summary: NotificationSummary) => void | Promise<void>;
  poll: () => NotificationSummary[] | Promise<NotificationSummary[]>;
  notify: (message: string, summary: NotificationSummary) => void | Promise<void>;
  intervalMs?: number;
}): PollingWatcher {
  const seen = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    const summaries = await input.poll();
    for (const summary of summaries) {
      const dedupeKey = summary.notification_id ?? summary.packet_id;
      if (seen.has(dedupeKey)) continue;
      await input.notify(formatNotification(summary), summary);
      await input.ack?.(summary);
      seen.add(dedupeKey);
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, input.intervalMs ?? 5000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
  };
}

function toWebhookPayload(summary: NotificationSummary) {
  return {
    event: 'relay.notification',
    notification_id: summary.notification_id,
    packet_id: summary.packet_id,
    packet_type: summary.packet_type,
    sender: senderLabel(summary),
    sender_handle: summary.sender_handle,
    title: sanitizeNotificationText(summary.title),
    project: sanitizeNotificationText(summary.project),
    summary: sanitizeNotificationText(summary.summary),
    action: 'open/review',
  };
}

function senderLabel(summary: NotificationSummary): string {
  return summary.sender_handle.startsWith('@')
    ? summary.sender_handle
    : `@${summary.sender_handle}`;
}

function sanitizeNotificationText(value: string): string {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '[redacted]',
    )
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret|password)\s*=\s*[^\s"'`]+/gi, '[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[redacted]@')
    .slice(0, 500);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function windowsBalloonScript(title: string, body: string): string {
  const encodedTitle = Buffer.from(title, 'utf8').toString('base64');
  const encodedBody = Buffer.from(body, 'utf8').toString('base64');
  return `
    Add-Type -AssemblyName System.Windows.Forms;
    Add-Type -AssemblyName System.Drawing;
    $title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'));
    $body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedBody}'));
    $notify = New-Object System.Windows.Forms.NotifyIcon;
    $notify.Icon = [System.Drawing.SystemIcons]::Information;
    $notify.BalloonTipTitle = $title;
    $notify.BalloonTipText = $body;
    $notify.Visible = $true;
    $notify.ShowBalloonTip(5000);
    Start-Sleep -Seconds 6;
    $notify.Dispose();
  `;
}

function defaultRunNativeNotification(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? 'unknown status'}.`));
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
