/**
 * M29 mediainfo -- L27, the WINDOWS SHELL properties dialog.
 *
 * L27's first choice is `SHObjectProperties(hwnd, SHOP_FILEPATH, absPath, NULL)`
 * from shell32 through koffi. koffi is not a dependency of this project and
 * adding one is a `package.json` edit, which no feature module may make
 * (docs/parity/02-wave0-api.md section 0, rule 4). So this is the row's own
 * documented fallback, and the two gotchas it names are both handled here:
 *
 *  1. "it **pumps a modal message loop**, so calling it on Electron's main
 *     thread freezes the app for the dialog's lifetime". A separate
 *     `powershell.exe` IS the worker: the message loop it pumps is its own, and
 *     Electron's main thread never blocks. `-STA` is explicit because
 *     `Shell.Application` and a modal dialog need a single-threaded apartment
 *     (the row's koffi route says the same thing: `CoInitializeEx(NULL,
 *     COINIT_APARTMENTTHREADED)` first).
 *  2. "the PowerShell dialog **dies when that process exits**, which is why the
 *     sleep is there". Hence `Start-Sleep`, and hence the process being tracked:
 *     `ctx.lifecycle.trackProcess()` kills it on quit, and only one is ever
 *     alive at a time.
 *
 * ---------------------------------------------------------------------------
 * THE PATH IS NEVER INTERPOLATED INTO THE SCRIPT
 * ---------------------------------------------------------------------------
 * The obvious spelling of this row is
 * `-Command "$s.Namespace('<dir>').ParseName('<name>')..."`, and a filename
 * containing `'` then closes the string and the rest of the name is PowerShell
 * source. A media filename is attacker-controlled in every sense that matters
 * here: it arrives from a download, an archive or a network share. So the script
 * is a CONSTANT, and the two path halves are passed in the environment, where
 * nothing parses them. `buildInvocation` is pure and `shell-props.test.ts` drives
 * it with `'; rm -rf; #` in the filename to assert the constant never changes.
 */

/** The script. A constant -- see the header. `$env:` reads are not parsed. */
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$shell = New-Object -ComObject Shell.Application',
  '$folder = $shell.Namespace($env:RL_MI_DIR)',
  'if ($null -eq $folder) { exit 1 }',
  '$item = $folder.ParseName($env:RL_MI_NAME)',
  'if ($null -eq $item) { exit 1 }',
  "$item.InvokeVerb('Properties')",
  // The dialog belongs to this process; it closes when the process does.
  'Start-Sleep -Seconds $env:RL_MI_HOLD'
].join('; ')

export interface ShellPropertiesInvocation {
  file: string
  args: string[]
  env: Record<string, string>
}

/**
 * Split a path into the directory and the leaf `Namespace`/`ParseName` want.
 *
 * Returns null for anything that is not an absolute Windows path with a leaf:
 * a URL (a network source has no shell properties), a bare filename, a
 * directory. Better to grey the menu item out than to open a dialog on the
 * wrong object.
 */
export function splitForShell(p: string): { dir: string; name: string } | null {
  if (!/^[A-Za-z]:[\\/]|^\\\\[^\\/]/.test(p)) return null
  const norm = p.replace(/\//g, '\\')
  const slash = norm.lastIndexOf('\\')
  if (slash < 0) return null
  const dir = norm.slice(0, slash) || norm.slice(0, slash + 1)
  const name = norm.slice(slash + 1)
  if (name.length === 0) return null
  return { dir, name }
}

export function buildInvocation(p: string, holdSeconds = 3600): ShellPropertiesInvocation | null {
  const split = splitForShell(p)
  if (!split) return null
  return {
    file: 'powershell.exe',
    // -STA: see gotcha 1. -NoProfile: a user's profile can print, prompt or
    // fail, and this process must do exactly one thing.
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT],
    env: {
      RL_MI_DIR: split.dir,
      RL_MI_NAME: split.name,
      RL_MI_HOLD: String(Math.max(1, Math.round(holdSeconds)))
    }
  }
}

/** The literal script, for the test that asserts it is a constant. */
export const SHELL_PROPERTIES_SCRIPT = SCRIPT
