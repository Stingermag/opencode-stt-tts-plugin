// OpenCode TUI host resolves a local plugin's TUI entry by looking for a
// `tui` file inside the plugin directory (path.resolve(directory, "tui") +
// extension lookup), NOT via package.json "exports". Without this file the
// plugin is reported as "unsupported" and silently skipped by the TUI.
// (reconciliation probe v2)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

try {
  fs.appendFileSync(
    path.join(os.homedir(), ".local", "share", "opencode-voice.log"),
    `[${new Date().toISOString()}] module imported: tui.js, pid=${process.pid}\n`,
  )
} catch {}

export { default } from "./index.js"
