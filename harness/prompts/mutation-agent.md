# C6 mutation — apply ONE predefined semantic mutation (non-subject agent)

You are in a copy of an implementation of the specification in SPEC/ (read it if needed). English only.
Apply exactly this mutation to the SERVER-side code path that enforces the rule, with the smallest change that
breaks the rule (one condition, one check, one guard):

  $mutation_id: $mutation_description

For reference, this is how the same mutation looks on the reference implementation (the code here differs; apply it
by behavior, not by line):

```diff
$reference_patch
```

If the rule is enforced in several places, mutate the primary server-side one. If the rule does not exist
server-side, change nothing and write the single word NOT_APPLICABLE as your final message.
Do not run tests, do not touch test files, do not run git commands. End with one line: file and change.
