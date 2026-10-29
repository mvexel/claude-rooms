---
id: PRD
title: {title}
status: draft          # draft | review | agreed
agreed:                # set when the owner agrees; building is locked until then
updated: {now}
---
<!-- 120 lines max (rooms prd review refuses longer). Technical approach goes to notes/tech-approach.md, UX research to notes/ux-research.md. -->
## Purpose
Who has what problem, why now, and the one outcome. Keep the named-person story (a person, a place, a time) to 3 sentences.

## Stakeholders
One line each: users, the owner who decides, operators and maintainers, anyone affected, and what each needs.

## Goals and non-goals
Goals: up to three outcomes for users.
Non-goals: what this deliberately won't do.

## Functional requirements
FR1. When <X>, the user sees <Y>. (Numbered, each testable in one sentence, 12 at most, no mechanisms.)
FR2.

## Non-functional requirements
NFR1. Performance, privacy, accessibility, licences, cost or reliability, each with a threshold or a check.

## Assumptions
Believed, not verified. Each names how we find out (a T record) or says "accepted".

## Constraints
Data, legal, budget, platform, deadlines; what the team may not touch.

## High-level execution
Phase 1: what it delivers and the gate the owner holds.
Phase 2: (a sentence per phase, 3 to 5 phases; what a pilot or a stop looks like. No tasks, no owners.)

## Definition of done
What must be true, and checked by whom, before this counts as shipped.

## Open questions
Only questions that block agreement, each starting with its owner record: `Dnn Which platform first?` or `Tnn Can we measure load time? 4 h`. Delete this section before `agreed` if empty.

## Sign-off
Lead:
Reviewed by:          (optional: a reviewer's name and one line)
Owner:
