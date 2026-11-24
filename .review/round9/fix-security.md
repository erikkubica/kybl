# Round 9, security fixes

| id | verdict | what changed or why |
|----|---------|---------------------|
| S-1 | fixed | Verified (a comment ending in `\` + line break, then a lone quote). A template with a placeholder that has both a comment and a removed continuation is refused ("a comment and a line continuation"); each alone still passes. Rust and TS mirrors, vectors with `'` and `"`, and a real-shell test in bash, sh, zsh, ksh and dash. |
| S-2 | fixed | `plainForSheetJS` refuses a part named `*.zip` or `*.iwa` (any case), and a part that starts with `PK` or the compound-file magic. |
| S-3 | fixed | Same refusal removes `Index/Document.iwa`. The xlsx view also ends the worker after 15 s per request and shows the refusal text (timer cleared on answer and on unmount). |
| S-4 | fixed | `xls`, `xlsb` and `numbers` no longer map to a viewer (so "Open in another app"). A non-zip handed to `plainForSheetJS` (a compound file renamed to .xlsx) is refused too. CSV never reaches this worker. |
| S-5 | fixed | Commands are split at `; & | newline ( ) backtick { }` (a `&` in `2>&1`, `&>` or `>|` stays a redirection). Redirection words (also glued, `shift>/dev/null`) and their targets, keywords and assignments are skipped to find the command word; after `command`, `builtin`, `exec`, `env`, `nohup`, `time`, `nice`, `xargs`, `noglob`, `nocorrect` every later word counts. All builtin rules (name builtins, `shift`/`ulimit`, special-variable assignments, code builtins in `operand_problem`) use it. Vectors for each S.md row; real-shell test for the runnable ones. |
| S-6 | fixed | Added HISTCMD, JOBMAX, PPID. A sweep of 30 more names (EPOCHSECONDS, SRANDOM, COLUMNS, `_`, ...) with `X=`, `export`, `typeset` in bash, ksh, zsh and sh found no others. |
| S-7 | fixed | A placeholder inside a `(` that is not a command start (subshell, `$(`, `<(`, `name=(` before the command or after `declare` and kin) is refused, as is one glued to `(`, `[` or `{` before or after it. Message names zsh glob qualifiers. Real zsh runs `echo x({name})`, `echo a ({name})`, `echo a list=({name})`. |
| S-8 | fixed | Command words `alias`, `fc`, `enable` refused; `source`/`.` with `$` or a backtick operand refused; any `functions`/`aliases`/`galiases`/`saliases`/`commands` word with `[` or `=` refused. Real shells run `alias a=$v` (sh) and `functions[1]=$v; 1` (zsh). |
| S-9 | fixed | SECRET pattern bounded (`{0,60}` each side). Line and detail are cut to 8,000 characters before redaction; the line is cut to 4,000 after it, so a credential straddling the cut is hidden. Tests for speed and the straddle. |

Checks: tsc, vite build, pnpm test (196 pass), cargo test --lib (696 pass, 0 warnings). Rust and TS checkers gave identical answers on 590 000 generated templates (the corpus from /private/tmp/r9s), after aligning `PATH++=` handling in TS. Test shells ran with a 5 s limit and process-group kill; no processes left.
