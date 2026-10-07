# Labelling protocol (frozen before any witness run)

Candidates: candidates.json (index = array position). Source repo: /home/user/job_tracker (full history, Go 1.26 works offline).

For each assigned candidate:
1. Make a throwaway worktree at `reviewed_commit_sha` (`git worktree add /tmp/wt-<idx> <sha>`; never modify the main checkout; remove the worktree after).
2. Decide the TRUTH of the finding's behavioural claim **by running code** (a Go test or small program in the worktree). The maintainer reply is NOT evidence of truth: use it only to understand what the claim meant. If a fix commit is cited, you may use it to understand the claim, not to label it.
   - truth `true`: claim reproduces at the reviewed commit.
   - truth `false`: the code behaves correctly; claim does not reproduce.
   - truth `opinion`: not a behavioural claim (style/design/preference) after all.
   - truth `unlabelable`: cannot be decided by execution (needs network/DB/timing, or the claim is too vague). Say why. These are dropped, not forced.
3. For `true`, attribution: `regression` if the faulty code is introduced/changed by this PR (check `git merge-base <reviewed_sha> <pr_base_sha>` and diff), else `preexisting`.
4. Record `evidence`: the exact command and a 1-3 line quote of its output. If you could not run something, say so; label unverified assumptions as such.
5. `weak: true` if a reasonable engineer could argue the label either way.
Output: JSON array of {idx, pr, file, truth, attribution?, weak, evidence, notes}.
