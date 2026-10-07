import pc from 'picocolors';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { loadNotifyConfig, notifyHuman } from '../core/notify.js';

/** `nativ notify test`: sends a sample notification so a person can check the webhook or command works. */
export async function runNotifyTest(targetDirArg?: string): Promise<void> {
  const root = resolveProjectRoot(targetDirArg);
  const config = loadNotifyConfig(root);
  if (!config) {
    console.log(pc.yellow('\nNotifications are off. Add to .nativ/config.json:'));
    console.log(pc.white('  { "notify": { "webhook": "https://hooks.slack.com/services/..." } }'));
    console.log(pc.dim('  or "command": "notify-send nativ \\"$(jq -r .text)\\"", or set NATIV_NOTIFY_WEBHOOK / NATIV_NOTIFY_COMMAND.\n'));
    process.exitCode = 1;
    return;
  }
  const result = await notifyHuman(
    root,
    { event: config.events[0], taskId: 'task-test', summary: 'This is a test notification from `nativ notify test`', question: 'Did it arrive?', options: ['Yes', 'No'] },
    { force: true },
  );
  for (const e of result.errors) console.error(pc.red(`✖ ${e}`));
  if (result.sent) {
    const via = [config.webhook && 'webhook', config.command && 'command'].filter(Boolean).join(' and ');
    console.log(pc.green(`\n✔ Test notification sent via ${via}. Events: ${config.events.join(', ')}.\n`));
  } else {
    process.exitCode = 1;
  }
}
