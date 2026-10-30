---
id: PRD
title: Hosted Rooms
status: draft
stage: future
agreed:
updated: 2026-10-30
---

# Hosted Rooms

## Purpose

Martijn checks Rooms from his phone while agents work on x1 or his Mac. Today the tracker URL and availability depend on the execution machine, and it is hard to tell which host owns a room. Provide one dependable place to answer cards and follow the work, even while an execution host is offline.

## Stakeholders

- Owner: answer decisions and prose questions, follow delivery, and see what needs attention.
- Lead and workers: receive instructions once and keep the room record current.
- Operator: deploy, update, back up, and restore the tracker on a small VPS.

## Goals and non-goals

Goals: one stable tracker URL; reliable answers across host disconnections; clear room ownership with one open room per repository per execution host.

Non-goals for the first version: running all agents on the VPS, moving product repositories or their credentials there, public signup, billing, subscriptions, or launching a paid product.

## Functional requirements

FR1. When the owner opens the tracker, they see rooms from all registered execution hosts and the host assigned to each room.

FR2. When a repository already has an open room on a host, another room for that repository cannot be opened on the same host, including during simultaneous requests. Other repositories on that host may each have a room. Pausing keeps the slot occupied; closing releases it.

FR3. When an execution host disconnects, the tracker remains available, labels that host offline, and preserves pending answers for delivery after reconnection.

FR4. When the owner answers a card, they see whether the answer is saved, delivered, or read; retrying an interrupted submission does not create another answer.

FR5. When the page updates while the owner types, the draft, editor focus, caret or selection, and visible page position remain intact.

FR6. When a card asks for prose, it presents an answer editor and Send action. Completion tasks allow an observation or note alongside completion.

FR7. When a runner reports progress, the tracker distinguishes host connectivity, session activity, blocked work, and waiting for the owner.

FR8. When a room changes, the CLI, plugin, and tracker use the same authoritative record; a local snapshot cannot silently overwrite newer changes.

FR9. When existing records are imported, their IDs, answers, dependencies, and history remain available, and conflicting open-room assignments require explicit reconciliation.

FR10. When the operator exports or backs up a room, its record is available in readable Markdown with Git history, alongside a restorable backup of runtime delivery state.

## Non-functional requirements

NFR1. Reading and writing require authenticated, authorized access; runner credentials are restricted to their assigned host and work.

NFR2. The service restarts after failure and exposes a health check. A process restart preserves saved answers and pending delivery.

NFR3. The initial capacity target is a VPS with 2 GB RAM and 20 GB disk for the tracker. Validate this with representative room and event data before selecting a plan.

NFR4. Backups are stored off the VPS. Demonstrate a restore onto a fresh instance before migration is complete; recovery frequency and retention remain to be agreed.

## Assumptions

- Proposed: agents continue on x1 and the Mac, with a runner on each. Revisit before approving implementation.
- Proposed: initial owner access stays private through Tailscale. Broader access is a separate product decision.
- Proposed: a central database becomes authoritative, with Markdown exports preserving human-readable records. Validate the CLI and worker editing workflow before approval.

## Constraints

This is a future draft. Saving it does not authorize hosted implementation, VPS spending, deployment, or migration. Product repositories and their credentials remain on their execution hosts. Existing rooms must not be closed or reassigned automatically.

## High-level execution

Phase 1: approve the product boundaries, record ownership model, access model, and operational targets; inspect existing room conflicts.

Phase 2: pilot the hosted tracker and durable event delivery with one execution host, retaining the existing setup for recovery.

Phase 3: connect the second host and verify disconnections, retries, concurrent room creation, and safe record updates.

Phase 4: restore a backup onto a fresh VPS, reconcile existing open rooms, and complete a controlled migration.

## Definition of done

The owner can use one stable URL to manage rooms on x1 and the Mac. All functional requirements pass checks covering real browser updates, API responses, saved records, and runner reconnection. Concurrent room creation admits only one open room per repository per host, retries cause no duplicate answer or execution, and backup restoration succeeds. The owner approves migration separately.

## Open questions

Resolve before promoting this draft to review: authoritative data and local editing model; VPS provider and spending cap; access beyond Tailscale; backup frequency and retention; whether a runner may work on anything outside its assigned room.

## Later reminder

**When we revisit this PRD or discuss a launch: Rooms could become a paid service. Revisit the audience, pricing, and product identity, and plan a polished, distinctive website.** This is a future product opportunity, not approval to build billing or a website now.

## Technical approach

See [Hosted Rooms architecture draft](hosted-rooms-architecture.md).

## Sign-off

Lead: draft recorded from the 2026-10-30 planning conversation.
Reviewed by:
Owner: not yet agreed.
