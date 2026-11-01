// Every test run gets its own empty Claude config dir, so nothing reads the
// owner's ~/.claude.json (folder trust, sessions) and results don't depend on
// which folders this machine trusts. A test that needs one sets its own.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'claude-config-'))
