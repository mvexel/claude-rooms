#!/bin/sh
# Stands in for codex. Logs argv and env facts to $FAKE_CODEX_LOG, then acts per $FAKE_CODEX_MODE:
#   ok (default)  thread.started, turn.completed, exit 0 (no rooms done)
#   done          also runs rooms done via $FAKE_CODEX_DONE (a shell command), then completes
#   fail          error + turn.failed, exit 1
#   crash         thread.started then exit 3 with no outcome
#   hang          thread.started then sleeps until killed
{
  echo "ARGS:$*"
  echo "PWD:$(pwd)"
  echo "ROOMS_AS:$ROOMS_AS"
  echo "TMPDIR:$TMPDIR"
  echo "SESSION:${CLAUDE_ROOMS_SESSION:-none}"
} >> "$FAKE_CODEX_LOG"
echo '{"type":"thread.started","thread_id":"thread-abc"}'
echo '{"type":"turn.started"}'
case "${FAKE_CODEX_MODE:-ok}" in
  fail) echo '{"type":"error","message":"bad model"}'; echo '{"type":"turn.failed","error":{"message":"bad model"}}'; exit 1;;
  crash) exit 3;;
  hang) sleep 5; exit 0;;
  done) sh -c "$FAKE_CODEX_DONE" >> "$FAKE_CODEX_LOG" 2>&1;;
esac
echo '{"type":"turn.completed","usage":{}}'
