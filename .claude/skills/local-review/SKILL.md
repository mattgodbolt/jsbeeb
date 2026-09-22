---
name: local-review
description: The review loop that runs before `gh pr create` and before every push to an open PR. Assembles the PR title and body, launches the local-reviewer agent on the diff, fixes or answers every finding, and repeats until nothing would block.
---

# Local review

Run this before `gh pr create` and before every `git push` to a branch with an open PR. Never skip
it because the change is small; the small ones are where the whitespace goes missing. A push to a
branch with no PR yet, for someone to pull and try, needs no review; the review comes before the
PR. What the reviewer checks, how it reports and what it needs to be told are its own
(`.claude/agents/local-reviewer.md`); this is the loop around it.

## 1. Establish the diff

- The base is the PR's base branch (`gh pr view --json baseRefName` for an open PR; for one not
  yet opened, the branch it will be opened against, which is `main` unless the PR is stacked).
  `git fetch origin <base>` and review against `origin/<base>`.
- Commit everything first, so the diff and the files the reviewer reads agree. Never amend or
  rebase a branch that has been pushed.
- For a push to an open PR, seed the taken and declined lists with what is already settled, so
  the reviewer does not re-raise it. Taken: every answered thread whose reply names the commit
  that took it. Declined: the "Declined from local review" section of the body
  (`gh pr view --json body`), and every review thread the maintainer or the session has answered
  (`gh api --paginate repos/<owner>/<repo>/pulls/<n>/comments` for the inline threads and their
  replies, `gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews` for the review bodies, and
  `gh api --paginate repos/<owner>/<repo>/issues/<n>/comments` for the conversation; without
  `--paginate` a busy PR's older threads are missed). A finding the
  maintainer declined there is declined here, with his reason.
- `git diff origin/<base>...HEAD --stat` to see what is in it.

## 2. Assemble the PR text

Write the title and body exactly as they will be posted, or as they will read on the open PR after
this push. The reviewer checks them against the diff, so they come first, not after.

## 3. Launch the reviewer

Use the Agent tool with `subagent_type: local-reviewer`, in the foreground, and wait for the report.
Do not run it in the background; a backgrounded report can arrive after the session has moved on.
The brief carries what the reviewer's Input section asks for: the base, the PR text from step 2,
the round number, and the findings earlier rounds took (with their commits) or declined (with
their reasons).

## 4. Act on the report

For each blocking or should-fix finding:

- **Agree:** fix it. When the fix changes behaviour, add the test that would have caught it; a
  comment, doc or convention fix needs none. Run `npm run lint`, `npm run format` and
  `npx vitest run` on the test files the diff touches, then commit the fix as a new commit and
  add the finding and that commit to a running list of taken findings, which the next round's
  brief carries.
- **Disagree:** write the reason into a running list of declined findings, as a sentence somebody
  else could evaluate. "Out of scope" has to say where the work goes instead (an issue, a follow-up
  PR).

A note is left to the session: decide it, and record the decision in the PR body where it bears on
what the reader should know. It needs no fix and no reason.

## 5. Repeat

Go back to step 2, since a fix can change what the PR text should say, and then step 3 with the
new diff and the declined list. Stop when the reviewer reports `Would block: 0`, or when every
remaining blocking finding has been declined with a reason and the reviewer, having seen that
reason, has nothing new to add. A should-fix finding taken in the final round is not re-reviewed;
that is the trade against an endless loop.

Four rounds at most. A blocking finding still open after the fourth report, whether the session
would fix it or decline it, goes to the user with both positions rather than to GitHub: a fix made
after the last round would be pushed unreviewed, and a change that has not converged in four rounds
is saying something about its design.

## 6. Push, then open or update

Only now `git push`, then `gh pr create --title <title> --body-file <file>` or
`gh pr edit --title <title> --body-file <file>`, with the text from step 2 written to that file,
so the title describes what landed and not the first attempt. The body carries every declined
finding under a heading "Declined from local review", each with its reason, so the second review
can see what the first review argued about.
