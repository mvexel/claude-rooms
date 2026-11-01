#!/bin/sh
# Stands in for codex. Logs argv and env facts to $FAKE_CODEX_LOG, then acts per $FAKE_CODEX_MODE:
# FAKE_CODEX_RESUME=norollout: a resume exits 1 before any JSON, like codex with an unknown session.
# Resume (`exec resume <id>`) logs PROMPT (the last arg) and emits no thread.started; FAKE_CODEX_SLEEP delays it.
#   ok (default)  thread.started, turn.completed, exit 0 (no rooms done)
#   done          also runs rooms done via $FAKE_CODEX_DONE (a shell command), then completes
#   fail          error + turn.failed, exit 1
#   crash         thread.started then exit 3 with no outcome
#   slow          sleeps 2s, then completes
#   hang          thread.started then sleeps until killed
{
  echo "ARGS:$*"
  echo "PWD:$(pwd)"
  echo "ROOMS_AS:$ROOMS_AS"
  echo "TMPDIR:$TMPDIR"
  echo "SESSION:${CLAUDE_ROOMS_SESSION:-none}"
  echo "GITCFG:${GIT_CONFIG_COUNT:-0} $(env | grep '^GIT_CONFIG_\(KEY\|VALUE\)' | sort | tr '\n' ' ')"
} >> "$FAKE_CODEX_LOG"
case "$1 $2" in
  "exec resume") [ "${FAKE_CODEX_RESUME:-}" = norollout ] && { echo "Error: no rollout found for thread id $5" >&2; exit 1; }
    echo "PROMPT:$(for last; do :; done; echo "$last" | tr "\n" " ")" >> "$FAKE_CODEX_LOG"
    [ -n "$FAKE_CODEX_SLEEP" ] && sleep "$FAKE_CODEX_SLEEP";;
  *) echo '{"type":"thread.started","thread_id":"thread-abc"}';;
esac
echo '{"type":"turn.started"}'
case "${FAKE_CODEX_MODE:-ok}" in
  fail) echo '{"type":"error","message":"bad model"}'; echo '{"type":"turn.failed","error":{"message":"bad model"}}'; exit 1;;
  crash) exit 3;;
  hang) sleep 5; exit 0;;
  slow) sleep 2;;
  done) sh -c "$FAKE_CODEX_DONE" >> "$FAKE_CODEX_LOG" 2>&1;;
esac
echo '{"type":"turn.completed","usage":{}}'
