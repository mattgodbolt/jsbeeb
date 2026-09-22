---
name: local-review
description: The review loop that runs before `gh pr create` and before every push to an open PR. Assembles the PR title and body, launches the local-reviewer agent on the diff, fixes or answers every finding, and repeats until nothing would block.
---

# Local review

Run this before `gh pr create` and before every `git push` to a branch with an open PR. Never skip
it because the change is small; the small ones are where the whitespace goes missing. Copilot and
the maintainer are the second review, not the first.

## 1. Establish the diff

- The base is the PR's base branch (`gh pr view --json baseRefName` for an open PR; for one not
  yet opened, the branch it will be opened against, which is `main` unless the PR is stacked).
  `git fetch origin <base>` and review against `origin/<base>`.
- Commit everything first; the reviewer reads commits, not the working tree. Never amend or rebase
  a branch that has been pushed.
- `git diff origin/<base>...HEAD --stat` to see what is in it.

## 2. Assemble the PR text

Write the title and body exactly as they will be posted, or as they will read on the open PR after
this push. The reviewer checks them against the diff, so they come first, not after.

## 3. Launch the reviewer

Use the Agent tool with `subagent_type: local-reviewer`, in the foreground, and wait for the report.
Do not run it in the background; a backgrounded report can arrive after the session has moved on.
The brief carries:

- the base ref
- the PR title and body from step 2
- the round number
- every finding from earlier rounds that was declined, with the reason

## 4. Act on the report

For each finding:

- **Agree:** fix it, and add the test that would have caught it. Run `npm run lint`,
  `npm run format:check` and `npx vitest run` on the test files the diff touches, then commit the
  fix as a new commit.
- **Disagree:** write the reason into a running list of declined findings, as a sentence somebody
  else could evaluate. "Out of scope" has to say where the work goes instead (an issue, a follow-up
  PR).

## 5. Repeat

Go back to step 2, since a fix can change what the PR text should say, and then step 3 with the
new diff and the declined list. Stop when the reviewer reports `Would block: 0`, or when every
remaining blocking finding has been declined with a reason and the reviewer, having seen that
reason, has nothing new to add. A should-fix finding taken in the final round is not re-reviewed;
that is the trade against an endless loop.

Four rounds at most. If the fourth still has a blocking finding the session will not fix, stop,
do not push, and put the finding and both positions in front of the user: a change that has not
converged in four rounds is saying something about its design.

## 6. Push, then open or update

Only now `git push`, then `gh pr create` or `gh pr edit --body`. The body carries every declined
finding under a heading "Declined from local review", each with its reason, so the second review
can see what the first review argued about.
