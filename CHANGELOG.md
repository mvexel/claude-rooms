# Changelog

## 0.4.0

Everything merged into `rooms-maint/int` since 0.3.2.

- **Loopback page writes with `ROOMS_USERS` (#22).** A connection from loopback with no proxy headers counts as the local user and may answer even when `ROOMS_USERS` is set. `ROOMS_TRUST_LOOPBACK=0` turns that off, so every POST needs a listed login.
- **CSRF guard on page POSTs.** POSTs whose `Origin` does not match `Host` are refused with 403, and POST bodies must be `application/json`. The 403 names the URL that was actually requested.
- **Todo-card steps as code blocks (#40).** Commands on todo cards render as code blocks with Copy buttons.
- **Agents get a name, an avatar and a page (#27).**
- **Settings and status page (#34).** `/api/settings` reads and writes the overrides file; the config reloads live. Changes apply to the next spawn. `lead.permissionMode`, `lead.allowedTools` and `worker.permissionMode` stay file-only.
- **Hall monitor (#35).** Past `hallMonitor.queueLimit` ready items waiting behind one `owner` role, `rooms status` names clones ("dev 2") and `rooms spawn` starts them under that name. `hallMonitor.maxThreads` (default 4) caps running workers per room; spawn refuses beyond it unless `--over-cap`.
- **Codex workers (#26).** `rooms spawn <room> Tnn --backend codex` runs an item with `codex exec --json`. Model, effort, sandbox, `addDirs` and `network` come from `codex` in `config.json`. `rooms tell <room> "..." --item Tnn` queues a message and resumes the same Codex thread. Codex commits are unsigned (`commit.gpgsign=false` for that run only).
- **Worker deliveries are requests to act (T33).** A `[rooms]` note addressed to an item tells the worker to act in this turn and log the result, not an FYI event feed.
- **Codex smoke test and docs (T28).** The lead and worker skills document `--backend codex`.
