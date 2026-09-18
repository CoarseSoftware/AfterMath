import { execFile } from 'child_process';

function ps(command: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 15000 },
      () => resolve() // best-effort: never reject
    );
  });
}

function psArg(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Best-effort Windows notification: a taskbar toast with a sound via
 * BurntToast; falls back to a system-sound beep. Never throws, never blocks
 * the caller (fire and forget).
 */
export async function notify(title: string, message: string, sound: boolean): Promise<void> {
  try {
    // Preferred: BurntToast (supports audio). Fails fast if the module is missing.
    const cmd =
      `try { ` +
      `Set-BurntToastNotification -AppId "AfterMath" ` +
      `-Title ${psArg(title)} -Message ${psArg(message)} ` +
      (sound ? `-Audio Default ` : '') +
      `} catch {}`;
    await ps(cmd);
    // Fallback: play a system sound if BurntToast wasn't installed.
    if (sound) {
      await ps(`try { [System.Media.SystemSounds]::Exclamation.Play() } catch {}`);
    }
  } catch {
    /* notification is best-effort */
  }
}
