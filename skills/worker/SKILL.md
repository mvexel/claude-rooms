---
name: worker
description: Work one item in a claude-rooms room. Use when you were started on an item (Tnn) of a room, or told to load rooms:worker.
---

# Working an item

Your item file is your brief. It holds the Acceptance (what done means), the Inputs (what to read), and a cap in hours. The room's `BRIEF.md` has your charter. In a feature room, `rooms brief <room>` prints the binding set (the PRD and agreed refinements): code that contradicts it doesn't get written.

1. **Read the item and its Inputs.** A dependency is met when the upstream item is `done` and its Result names the artifact.
2. **Work in your own worktree** (named in Inputs), on its branch. Keep scratch in the folder you were given (`export TMPDIR=<it>`), never in `/tmp`. Commit on your branch with a `Work-Item: <room>/<Tnn>` trailer. Don't push or merge to a product repo's main: the lead merges.
3. **Log as you go:** `ROOMS_AS=<your name> rooms log <room> <Tnn> "<short line>"`. Put long reasoning in `notes/<role>.md` in the room (in a room on the hub: in the working copy `rooms brief <room>` prints, under `work/<room>/notes/`; any `rooms` command takes it to the hub).
3a. **Never ask the user.** You have no line to the owner: AskUserQuestion is disabled for workers. A question goes through `rooms need <room> <Tnn> "<question>"`; an assumption you proceed on goes in `rooms log`.
4. **Don't widen your item.** If you can't go on without work nobody planned, run `rooms need <room> <Tnn> "<what is missing and why>"` and end your turn with that as your report. The lead decides.
5. **Finish.** Fill in the item's `## Result`:
   - `Done:` what you did.
   - `Artifacts:` paths and commit shas.
   - `Unverified:` what you didn't check.
   - `Next:` the record that carries the work on, or `none (why)`.
   Then run `rooms done <room> <Tnn>`, or `--review` if someone should check it first. That tells the lead. Stop servers and browsers you started.
6. **Found a bug or surprise outside your item?** Log it with a command that reproduces it and say so in your Result. The lead makes it an item.

Messages from the lead arrive as `[rooms]` notes (and are kept in your item's Log). A `[rooms]` note addressed to your item is a request: act on it in this turn, `rooms log` what you did, then end the turn. You may be running on Codex (`--backend codex`, same rules; `rooms need` to ask, Result then `rooms done`), and your commits there are unsigned by design. If the lead dispatched you as a clone ("dev 2"), the role and the rules are the same. If the room is paused, finish the step you're in, write your Result, and stop.
