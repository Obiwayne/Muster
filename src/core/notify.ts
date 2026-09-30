// Desktop notification. Windows toast through PowerShell's WinRT bridge; silently does nothing elsewhere or on failure.
import { spawn } from 'node:child_process';
import type { MusterConfig } from '../types.js';

// PowerShell's own AppUserModelID: always registered, so toasts show without installing anything.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

// Title and text travel in env vars so no quoting of user text is ever needed.
const SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:MUSTER_TOAST_TITLE)) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:MUSTER_TOAST_TEXT)) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;

export function notify(config: Pick<MusterConfig, 'notify'>, title: string, text: string): void {
  if (!config.notify || process.platform !== 'win32' || process.env.MUSTER_NO_NOTIFY) return;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, MUSTER_TOAST_TITLE: title, MUSTER_TOAST_TEXT: text.slice(0, 250) },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* notifications are best effort */
  }
}
