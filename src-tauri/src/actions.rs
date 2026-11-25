//! Custom actions (Settings → Actions): a shell command line with placeholders, run on the
//! selected files and folders, on this computer (`$SHELL -l -c` for a POSIX shell, else /bin/sh with that shell's PATH) or on an SFTP
//! server over SSH.
//!
//! Templates are shell commands on purpose, but every placeholder value is shell-quoted (single
//! quotes), so a file name can never become part of the command. Output streams to the page as
//! `custom-action-output` events, at most [`OUTPUT_LIMIT`] per run; nothing of it is logged.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::state::AppState;

/// Output passed on per run; the rest is dropped (the process keeps running).
pub const OUTPUT_LIMIT: usize = 1024 * 1024;

/// Placeholders that make the command run once per item.
const PER_ITEM: [&str; 4] = ["path", "name", "ext", "stem"];

/// One selected item: an absolute path (on this computer, or on the server).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    #[serde(default)]
    pub is_dir: bool,
}

// ---------------------------------------------------------------- template expansion

/// `s` as one shell word: single quotes, with each quote and backslash written outside them,
/// escaped (`'\''`, `'\\'`). Nothing between the quotes is then special to any shell: POSIX
/// shells, fish (where `\'` and `\\` are escapes even inside single quotes) and csh all read it
/// back as `s`.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\'' => out.push_str(r"'\''"),
            '\\' => out.push_str(r"'\\'"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Whether `s` reads back the same through [`quote`] in every shell: no line break or other
/// control character. csh and tcsh end a command at a newline even inside single quotes, and no
/// quoting of a newline reads the same there and in POSIX shells, so text that goes to a server's
/// shell must not hold one.
pub fn plain_text(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// Put before a server script that `cd`s into a folder others can write to: PATH keeps only
/// absolute folders, so a `zip` or `rg` there is never the one that runs (a PATH with `.` or an
/// empty entry would find it). With no absolute folder at all it is /usr/bin:/bin: an empty PATH
/// makes most shells search the current folder.
const ABSOLUTE_PATH: &str = "set -f; P=; IFS=:; for d in $PATH; do case $d in /*) P=$P${P:+:}$d;; esac; done; unset IFS; set +f; PATH=${P:-/usr/bin:/bin}; export PATH; ";

/// A command for an SSH exec channel: `script` (POSIX sh, one line) run by /bin/sh, which replaces
/// the login shell (`exec`, so a Stop signal reaches the script and its trap), whatever the
/// account's login shell is (fish and csh read the quoting the same way, see [`quote`]), with an
/// absolute-only PATH. None when the script (a name in it) holds a line break or another control
/// character (see [`plain_text`]): it isn't sent.
pub fn sh_c(script: &str) -> Option<String> {
    let script = format!("{ABSOLUTE_PATH}{script}");
    plain_text(&script).then(|| format!("exec /bin/sh -c {}", quote(&script)))
}

/// A path or name as one word that can't be read as an option: one starting with "-" gets "./".
fn arg(s: &str) -> String {
    if s.starts_with('-') {
        quote(&format!("./{s}"))
    } else {
        quote(s)
    }
}

/// The last part of a path, without a trailing separator. A backslash separates only in a path on
/// this computer under Windows (`windows`): on macOS, Linux and every server it is a character a
/// name can hold.
fn name_of(path: &str, windows: bool) -> &str {
    let seps: &[char] = if windows { &['/', '\\'] } else { &['/'] };
    let p = path.trim_end_matches(seps);
    p.rsplit(seps).next().unwrap_or(p)
}

/// (stem, extension) of a name: "photo.jpg" → ("photo", "jpg"); ".bashrc" and folders have none.
fn split_ext(name: &str, is_dir: bool) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if !is_dir && i > 0 && i + 1 < name.len() => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// Replaces `{word}` where `value(word)` has something. `${word}` is left to the shell.
fn substitute(template: &str, value: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let word_len = after.find(|c: char| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(after.len());
        let closed = after[word_len..].starts_with('}');
        let shell_var = rest[..open].ends_with('$');
        match (closed && !shell_var).then(|| value(&after[..word_len])).flatten() {
            Some(v) => {
                out.push_str(&rest[..open]);
                out.push_str(&v);
                rest = &after[word_len + 1..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whether the template names `{word}` as a placeholder (not `${word}`).
fn uses(template: &str, word: &str) -> bool {
    let needle = format!("{{{word}}}");
    template.match_indices(&needle).any(|(i, _)| !template[..i].ends_with('$'))
}

/// Every placeholder the template can hold.
const PLACEHOLDERS: [&str; 6] = ["path", "name", "ext", "stem", "paths", "dir"];

/// Refuses a template that puts a placeholder anywhere Kybl can't prove its quoting holds. The
/// value is single-quoted already, and that only keeps it one plain word where the shell reads
/// commands: outside every quote, or inside `$( … )` (a fresh context, even inside double quotes).
/// An allow-list: inside quotes, `$'…'`, backticks, `${ … }`, `$(( … ))`, `(( … ))`, `$[ … ]`, a
/// here-document or a comment, in the word after `>&`/`<&`, as what a builtin reads as code
/// (see [`operand_problem`]), or after something shells read differently (a `#` inside a word,
/// `case`, a comment or a `)` in `${ … }` inside `$( … )`, a line continuation inside a word, `\'`
/// in `$'…'`), a placeholder is refused. A template with any placeholder that evaluates anything
/// (arithmetic, an array index, `eval`) is refused whole, see [`evaluation_problem`]. Mirrored in src/actions/lib/templateCheck.ts; both run
/// tests/actions/template-vectors.json. The error names the placeholder.
pub fn check_template(template: &str) -> Result<(), String> {
    // the shell deletes every backslash + line break before it reads a word, so scan what it will
    // read: a placeholder after `>&\⏎   ` or `$\⏎'` is then judged where the shell puts it (R8 S-6)
    let unfolded = unfold(template);
    // a continuation was removed: a comment ending in a backslash does NOT continue in a shell,
    // so with both in one template the comment's real end can't be judged (R9 S-1)
    let folded = unfolded.len() != template.len();
    let template = unfolded.as_str();
    #[derive(Clone, Copy, PartialEq)]
    enum Ctx {
        Plain,
        Single,
        Double,
        /// `$'…'`, where `\` escapes the next character (`\'` too)
        AnsiC,
        Backtick,
        /// `$( … )`, with how many plain `(` are open inside it
        Subst(u32),
        /// `${ … }`, with how many plain `{` are open inside it
        Brace(u32),
        /// `$(( … ))` or `(( … ))`, with how many `(` are open inside it
        Arith(u32),
        /// `$[ … ]`, with how many `[` are open inside it
        ArithSq(u32),
    }
    let mut stack = vec![Ctx::Plain];
    let b = template.as_bytes();
    let placeholder_at = |i: usize| PLACEHOLDERS.iter().find(|w| template[i..].starts_with(&format!("{{{w}}}")));
    // where a word can start (a `#` there begins a comment)
    let word_start = |i: usize| i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'\n' | b'\r' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>');
    // where a `#` begins a comment: after UNESCAPED whitespace or an operator, or at the start. Not
    // after `\ `, `\;`…, and not after a `)` (it may close `$( … )` or `<( … )`, which go on as one
    // word: `a\ #b` and `$(x)#b` hold a literal `#`). Those count as a `#` inside a word (R10 S-4)
    let comment_start = |i: usize| i == 0 || (word_start(i) && b[i - 1] != b')' && b[..i - 1].iter().rev().take_while(|&&x| x == b'\\').count() % 2 == 0);
    // a here-document (`<<`, not bash's `<<<`) seen: its body is read like double quotes
    let mut heredoc = false;
    // something seen that shells read differently: what follows can't be proven
    let mut unsure = false;
    // in the word after `>&` or `<&` (bash 3.2 expands it once more): the stack depth there, and
    // whether the word has begun
    let mut dup: Option<(usize, bool)> = None;
    // an expansion (`$…` or backticks) seen in a word after `>&` or `<&`: bash 3.2 expands that
    // word twice, so a variable holding a file name runs there (R8 S-3). Refused with a placeholder.
    let mut dup_expansion = false;
    // a comment seen (a `#` where a word starts, outside quotes)
    let mut comment = false;
    // every plain `(` still open, true for one that is NOT a subshell, array value or process
    // substitution: zsh reads what is in it as glob qualifiers, and `$( … )` in a qualifier runs
    // even when it was quoted (R9 S-7)
    let mut parens: Vec<bool> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let ctx = *stack.last().unwrap();
        let c = b[i];
        // where the shell reads commands (not inside quotes or an expansion)
        let code = matches!(ctx, Ctx::Plain | Ctx::Subst(_));
        if let Some((depth, started)) = dup {
            if stack.len() < depth || (stack.len() == depth && matches!(c, b'\n' | b'\r' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>')) {
                dup = None;
            } else if stack.len() == depth && matches!(c, b' ' | b'\t') {
                if started {
                    dup = None;
                }
            } else {
                dup = Some((depth, true));
            }
        }
        if dup.is_some_and(|(depth, _)| stack.len() >= depth) && (c == b'$' || c == b'`') {
            dup_expansion = true;
        }
        if code && c == b')' && !matches!(ctx, Ctx::Subst(0)) {
            parens.pop();
        }
        if code && c == b'(' && b.get(i + 1) != Some(&b'(') && !(i > 0 && b[i - 1] == b'$') {
            parens.push(glob_paren(template, i));
        }
        // `\{path}`: the backslash would then sit right before the opening quote of the value
        if c == b'\\' && ctx != Ctx::Single {
            if let Some(w) = placeholder_at(i + 1) {
                return Err(format!("{{{w}}} comes right after a backslash. Take the backslash away: it would undo Kybl's quoting of the file name."));
            }
            // dash and ash end `$'…'` at `\'` (no ANSI-C quoting there)
            if ctx == Ctx::AnsiC && b.get(i + 1) == Some(&b'\'') {
                unsure = true;
            }
        }
        // bash 3.2 ends `$( … )` at the first `)` of a `${ … }` in it
        if c == b')' && stack.iter().position(|c| matches!(c, Ctx::Subst(_))).is_some_and(|s| stack[s..].iter().any(|c| matches!(c, Ctx::Brace(_)))) {
            unsure = true;
        }
        if code && b[i..].starts_with(b"<<") && !b[i..].starts_with(b"<<<") && !(i > 0 && b[i - 1] == b'<') {
            heredoc = true;
        }
        if code && matches!(c, b'>' | b'<') && b.get(i + 1) == Some(&b'&') {
            dup = Some((stack.len(), false));
            i += 2;
            continue;
        }
        if code && c == b'#' {
            if comment_start(i) {
                // bash 3.2 finds the end of `$( … )` by counting parentheses, comments included
                if stack.iter().any(|c| matches!(c, Ctx::Subst(_))) {
                    unsure = true;
                }
                comment = true;
                // a comment, to the end of the line: a value with a line break would end it
                let end = b[i..].iter().position(|&x| x == b'\n').map_or(b.len(), |n| i + n);
                if let Some(w) = (i..end).find_map(|j| if b[j] == b'{' { placeholder_at(j) } else { None }) {
                    return Err(format!("{{{w}}} is in a comment (after #). Take it out of the comment."));
                }
                i = end;
                continue;
            }
            // csh reads a `#` inside a word as a comment too, sh doesn't (`$#` is a variable)
            if !(i > 0 && b[i - 1] == b'$') {
                unsure = true;
            }
        }
        // `case` patterns end in a lone `)`, which would seem to close the `$( … )`
        if matches!(ctx, Ctx::Subst(_)) && word_start(i) && b[i..].starts_with(b"case") && b.get(i + 4).is_none_or(|x| x.is_ascii_whitespace()) {
            unsure = true;
        }
        // a placeholder here (`${word}` is the shell's)
        if c == b'{' && !(i > 0 && b[i - 1] == b'$') {
            if let Some(w) = placeholder_at(i) {
                if heredoc {
                    return Err(format!("{{{w}}} is in a command with a here-document (<<). Pass it as an argument instead: inside a here-document a file name could run as a command."));
                }
                if matches!(ctx, Ctx::Single | Ctx::Double | Ctx::AnsiC) {
                    return Err(format!("{{{w}}} is inside quotes. Take the quotes away around it: Kybl quotes every placeholder itself, and inside other quotes a file name could run as a command."));
                }
                if stack.contains(&Ctx::Backtick) {
                    return Err(format!("{{{w}}} is inside backticks. Use $( … ) instead: inside backticks a file name could run as a command."));
                }
                if stack.iter().any(|c| matches!(c, Ctx::Brace(_))) {
                    return Err(format!("{{{w}}} is inside ${{ … }}. Use it outside: in there Kybl's quoting of the file name doesn't hold."));
                }
                if stack.iter().any(|c| matches!(c, Ctx::Arith(_) | Ctx::ArithSq(_))) {
                    return Err(format!("{{{w}}} is inside arithmetic ($(( … )) or (( … ))). Use it outside: in there a file name could run as a command."));
                }
                if dup.is_some() {
                    return Err(format!("{{{w}}} comes after >& or <&. Use > or < there instead: after >& some shells (bash on macOS) read the file name again as code."));
                }
                if unsure {
                    return Err(format!("{{{w}}} comes after a part shells read differently (a # inside a word, case or a comment inside $( … ), a line break inside a word…). Put it before that part, or rewrite it."));
                }
                if let Some(why) = operand_problem(template, i) {
                    return Err(format!("{{{w}}} {why}"));
                }
                // zsh reads `word(…)` and a `(…)` after a word as glob qualifiers, `[…]` as a
                // subscript or range: quotes inside them don't hold (R9 S-7)
                let end = i + w.len() + 2;
                let next_is_placeholder = placeholder_at(end).is_some();
                if parens.iter().any(|&g| g)
                    || matches!(b.get(end), Some(b'(' | b'['))
                    || (b.get(end) == Some(&b'{') && !next_is_placeholder)
                    || (i > 0 && matches!(b[i - 1], b'[' | b'{'))
                {
                    return Err(format!("{{{w}}} is glued to a ( [ or {{, or inside parentheses that follow a word. zsh reads those as glob qualifiers or subscripts, and there the quoting of the file name doesn't hold. Put a space around it, or use a plain argument."));
                }
            }
        }
        // a construct that opens here, and how many bytes start it
        let opens = |double: bool| -> Option<(Ctx, usize)> {
            match (c, b.get(i + 1), b.get(i + 2)) {
                (b'\'', ..) if !double => Some((Ctx::Single, 1)),
                (b'"', ..) if !double => Some((Ctx::Double, 1)),
                (b'`', ..) => Some((Ctx::Backtick, 1)),
                (b'$', Some(b'\''), _) if !double => Some((Ctx::AnsiC, 2)),
                (b'$', Some(b'('), Some(b'(')) => Some((Ctx::Arith(0), 3)),
                (b'$', Some(b'('), _) => Some((Ctx::Subst(0), 2)),
                (b'$', Some(b'{'), _) => Some((Ctx::Brace(0), 2)),
                (b'$', Some(b'['), _) => Some((Ctx::ArithSq(0), 2)),
                (b'(', Some(b'('), _) if code => Some((Ctx::Arith(0), 2)),
                _ => None,
            }
        };
        // `$$`, `$#`, `$?`, `$1`…: a whole parameter, so a `$(` or `$'` right after it is not one
        let special = c == b'$' && b.get(i + 1).is_some_and(|x| b"$#?!-@*".contains(x) || x.is_ascii_digit());
        match ctx {
            Ctx::Single => {
                if c == b'\'' {
                    stack.pop();
                }
            }
            Ctx::AnsiC | Ctx::Backtick => match c {
                b'\\' => i += 1,
                b'\'' if ctx == Ctx::AnsiC => {
                    stack.pop();
                }
                b'`' if ctx == Ctx::Backtick => {
                    stack.pop();
                }
                _ => {}
            },
            Ctx::Double => match c {
                b'\\' => i += 1,
                b'"' => {
                    stack.pop();
                }
                _ if special => i += 1,
                _ => {
                    if let Some((next, len)) = opens(true) {
                        stack.push(next);
                        i += len - 1;
                    }
                }
            },
            Ctx::Plain | Ctx::Subst(_) | Ctx::Brace(_) | Ctx::Arith(_) | Ctx::ArithSq(_) => {
                if c == b'\\' || special {
                    i += 1;
                } else if let Some((next, len)) = opens(false) {
                    stack.push(next);
                    i += len - 1;
                } else {
                    let top = stack.last_mut().unwrap();
                    match (*top, c) {
                        (Ctx::Subst(0), b')') | (Ctx::Brace(0), b'}') | (Ctx::ArithSq(0), b']') => {
                            stack.pop();
                        }
                        (Ctx::Subst(n), b'(') => *top = Ctx::Subst(n + 1),
                        (Ctx::Subst(n), b')') => *top = Ctx::Subst(n - 1),
                        (Ctx::Brace(n), b'{') => *top = Ctx::Brace(n + 1),
                        (Ctx::Brace(n), b'}') => *top = Ctx::Brace(n - 1),
                        (Ctx::ArithSq(n), b'[') => *top = Ctx::ArithSq(n + 1),
                        (Ctx::ArithSq(n), b']') => *top = Ctx::ArithSq(n - 1),
                        (Ctx::Arith(n), b'(') => *top = Ctx::Arith(n + 1),
                        (Ctx::Arith(0), b')') => {
                            // `))` ends it; a lone `)` means the shell may have read `$( (…) )`
                            if b.get(i + 1) == Some(&b')') {
                                i += 1;
                            } else {
                                unsure = true;
                            }
                            stack.pop();
                        }
                        (Ctx::Arith(n), b')') => *top = Ctx::Arith(n - 1),
                        _ => {}
                    }
                }
            }
        }
        i += 1;
    }
    if PLACEHOLDERS.iter().any(|w| uses(template, w)) {
        if comment && folded {
            return Err(code_why("a comment and a line continuation (a backslash at the end of a line); a shell does not continue a comment, so Kybl can't tell where it ends"));
        }
        if dup_expansion {
            return Err(code_why("an expansion after `>&` or `<&` (bash on macOS reads that word twice)"));
        }
        if let Some(why) = evaluation_problem(template) {
            return Err(why);
        }
    }
    Ok(())
}

/// The template as the shell reads it: every backslash + line break removed (an odd run of
/// backslashes before the break; an even run is escaped backslashes and a real line break).
/// Removed inside single quotes too, which can only make the scan stricter there.
fn unfold(t: &str) -> String {
    let mut out = Vec::with_capacity(t.len());
    let mut run = 0;
    for &c in t.as_bytes() {
        if c == b'\n' && run % 2 == 1 {
            out.pop();
            run = 0;
            continue;
        }
        run = if c == b'\\' { run + 1 } else { 0 };
        out.push(c);
    }
    // only ASCII bytes were dropped, so this is still valid UTF-8
    String::from_utf8(out).unwrap_or_else(|_| t.to_string())
}

const ARITH_WHY: &str = "This template has a placeholder and also does arithmetic (`$(( ))`, `(( ))`, `$[ ]`, let, -eq and the like, declare -i, an array index). A shell reads a variable it is used with as code there, so a file name such as a[$(cmd)] would run as a command, even though the placeholder is quoted. Do the arithmetic in a script of your own, or take the placeholder out of this template.";
const EVAL_WHY: &str = "This template has a placeholder and also eval, which runs text as code, so a file name could run as a command even though the placeholder is quoted. Take eval out of this template.";

/// The refusal for a construct that can read a variable's value as code.
fn code_why(what: &str) -> String {
    format!("This template has a placeholder and also {what}. A file name could run code through it, even though the placeholder is quoted. Take it out of this template, or do that part in a script of your own.")
}

/// Builtins refused anywhere in a template that has a placeholder: each reads or runs a variable's
/// value as code (a name with a subscript, a handler, an expression), or sets what the shell
/// evaluates later. A false alarm costs a rewrite, a miss runs a file name.
const BANNED_WORDS: [&str; 9] = ["read", "unset", "trap", "mapfile", "readarray", "compgen", "complete", "vared", "repeat"];
/// Builtins that read their operand as arithmetic in zsh or ksh: refused when given anything
/// but `$?`, `$#` or `$$`.
const NUMBER_BUILTINS: [&str; 7] = ["exit", "return", "break", "continue", "shift", "logout", "ulimit"];
/// Variables whose value the shell runs (every traced line, every prompt, the next shell).
const RUNNING_VARS: [&str; 3] = ["PS4", "PROMPT_COMMAND", "BASH_ENV"];
/// Variables the shell itself evaluates or runs when they are set (integer ones read the value as
/// arithmetic, so `a[$(cmd)]` runs; `ENV` is read by an interactive sh; the rest change how
/// words split or where commands come from). Assigning any of them is refused (R8 S-3).
/// `HISTCMD`, `JOBMAX` and `PPID` are integer variables in bash or ksh (R9 S-6); a sweep of every
/// variable these shells document found no others that evaluate a value.
const SPECIAL_VARS: [&str; 17] =
    ["OPTIND", "OPTARG", "RANDOM", "SECONDS", "TMOUT", "LINENO", "SHLVL", "MAILCHECK", "ENV", "BASH_ENV", "PS4", "PROMPT_COMMAND", "IFS", "PATH", "HISTCMD", "JOBMAX", "PPID"];
/// zsh's tables that define functions and aliases when written to.
const ZSH_TABLES: [&str; 5] = ["functions", "aliases", "galiases", "saliases", "commands"];

/// What `${body}` is, when it is not one of the allowed forms; None when it is allowed. The
/// allow-list (a name is `[A-Za-z_][A-Za-z0-9_]*`, w, p and r hold no quote, bracket or brace):
/// `name`, `1`, `@`, `*`, `?`, `$`, `#name`, `#`, `name[@]`, `name[*]`, `#name[@]`, `name:-w`,
/// `name:=w`, `name:+w`, `name:?w`, `name%p`, `name%%p`, `name#p`, `name##p`, `name/p/r`,
/// `name//p/r`. Everything else evaluates something or can't be proven plain.
fn brace_problem(body: &str) -> Option<&'static str> {
    let text_ok = |x: &str| !x.contains(['{', '}', '(', ')', '`', '"', '\'', '\\', '\n']);
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    if body.contains("${") {
        return Some("a nested `${ … ${ … } … }`");
    }
    if body.starts_with('!') {
        return Some("`${!name}` (indirect expansion, which evaluates the name it reads)");
    }
    if body.starts_with('(') {
        return Some("a zsh `${(flags)name}` (flags such as e or P evaluate the value)");
    }
    let (count, rest) = body.strip_prefix('#').map_or((false, body), |r| (true, r));
    let b = rest.as_bytes();
    let n = match b.first() {
        Some(c) if c.is_ascii_alphabetic() || *c == b'_' => b.iter().take_while(|&&c| ident(c)).count(),
        Some(c) if c.is_ascii_digit() => b.iter().take_while(|c| c.is_ascii_digit()).count(),
        Some(b'@' | b'*' | b'?' | b'$') => 1,
        _ => 0,
    };
    if n == 0 {
        return if count && rest.is_empty() { None } else { Some("a `${ … }` this check can't prove plain") };
    }
    let (name, tail) = rest.split_at(n);
    if tail.is_empty() {
        return None;
    }
    if tail == "[@]" || tail == "[*]" {
        return if name.as_bytes()[0].is_ascii_alphabetic() || name.as_bytes()[0] == b'_' { None } else { Some("a subscript on a number or symbol") };
    }
    if tail.starts_with('[') {
        return Some("a subscript `${name[ … ]}` (evaluated as arithmetic)");
    }
    if count {
        return Some("a `${ … }` this check can't prove plain");
    }
    if let Some(w) = tail.strip_prefix(':') {
        return match w.as_bytes().first() {
            Some(b'-' | b'=' | b'+' | b'?') if text_ok(&w[1..]) => None,
            Some(b'-' | b'=' | b'+' | b'?') => Some("a `${name:-word}` whose word holds quotes, brackets or braces"),
            _ => Some("a substring `${name:offset}` (the offset is evaluated as arithmetic)"),
        };
    }
    for op in ["%%", "%", "##", "#"] {
        if let Some(pat) = tail.strip_prefix(op) {
            return if text_ok(pat) { None } else { Some("a `${name%pattern}` whose pattern holds quotes, brackets or braces") };
        }
    }
    for op in ["//", "/"] {
        if let Some(r) = tail.strip_prefix(op) {
            return match r.split_once('/') {
                Some((p, rep)) if text_ok(p) && text_ok(rep) && !rep.contains('/') => None,
                _ => Some("a `${name/pattern/text}` this check can't prove plain"),
            };
        }
    }
    Some("a `${ … }` this check can't prove plain")
}

/// Why a template that has a placeholder can't be used however its placeholders are placed, or
/// None. Quoting only keeps the value one word; a shell that later evaluates a variable holding
/// it reads it as code. So the whole template is refused, not just the command with the
/// placeholder, when it can evaluate a variable. That is an ALLOW-LIST for parameter expansion
/// (see [`brace_problem`]; anything else in `${ … }`, and any subscript but `[@]`/`[*]`, is
/// refused), plus these refused outright: arithmetic (`$((`, `((`, `$[`, `let`, `-eq`…`-ge`,
/// `declare -i/-F/-E/-n`, an array index), `eval`, `read`, `unset`, `trap`, `mapfile`/`readarray`,
/// `printf -v`, `test -v`, `exit $x` and kin, and `PS4`/`PROMPT_COMMAND`/`BASH_ENV`. Text is
/// looked at whatever quotes it is in. Mirrored in templateCheck.ts.
fn evaluation_problem(t: &str) -> Option<String> {
    if t.contains("((") || t.contains("$[") {
        return Some(ARITH_WHY.to_string());
    }
    // the words as the shell will see them: `r""ead` and `\read` are `read`
    let plain: String = t.chars().filter(|c| !matches!(c, '\'' | '"' | '\\')).collect();
    let word_break = |c: char| c.is_ascii_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '`' | '<' | '>' | '{' | '}' | '$' | '=');
    for w in plain.split(word_break) {
        if w == "eval" {
            return Some(EVAL_WHY.to_string());
        }
        if matches!(w, "let" | "integer" | "float") || NUMERIC_TESTS.contains(&w) {
            return Some(ARITH_WHY.to_string());
        }
        if BANNED_WORDS.contains(&w) {
            return Some(code_why(&format!("`{w}`, which reads a variable's value as code or runs it")));
        }
        if RUNNING_VARS.contains(&w) {
            return Some(code_why(&format!("`{w}`, which the shell runs as code")));
        }
    }
    // the commands, split where a shell starts one: after `;` `&` `|` a line break, `(`, `)`, a
    // backtick or a brace, so `(OPTIND=$v)`, `$(export "$v")` and `case x) export "$v"` are seen
    // as the commands they are (R9 S-5)
    let masked = mask_placeholders(&plain);
    for words in commands(&masked) {
        let has = |x: &str| words.iter().any(|w| w == x);
        // a declaring builtin given a flag that makes the variable numeric or a name reference
        if words.iter().any(|w| ["declare", "typeset", "local", "export", "readonly", "private"].contains(&w.as_str())) {
            let flagged = |set: &[char]| words.iter().any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains(set));
            if flagged(&['i', 'F', 'E']) {
                return Some(ARITH_WHY.to_string());
            }
            if flagged(&['n']) {
                return Some(code_why("`declare -n` (a name reference, which reads a variable's value as a name with a subscript)"));
            }
        }
        if (has("printf") || has("print")) && has("-v") {
            return Some(code_why("`printf -v`, which takes its variable name as code"));
        }
        if (has("[") || has("[[") || has("test")) && (has("-v") || has("-R")) {
            return Some(code_why("a `-v` or `-R` test, which takes its variable name as code"));
        }
        // the command words: the first after keywords, redirections and `NAME=value` assignments,
        // and every word after a prefix such as `command -p` or `env` (what follows may be the command)
        let cands = command_words(&words);
        // an assignment (`X=…`, `export X=…`, `for X in …`) to a variable the shell evaluates, and
        // zsh's tables of functions and aliases (`functions[1]=$v` defines a function)
        for (k, w) in words.iter().enumerate() {
            let name = w.split_once('=').map(|(n, _)| n.trim_end_matches('+')).filter(|n| !n.is_empty()).or_else(|| (k > 0 && words[k - 1] == "for").then_some(w.as_str()));
            // `OPTIND[0]=` assigns the variable too (R10 S-3)
            let name = name.map(|n| n.split('[').next().unwrap_or(""));
            if let Some(n) = name.filter(|n| SPECIAL_VARS.contains(n)) {
                return Some(code_why(&format!("an assignment to `{n}`, which the shell evaluates or runs")));
            }
            let table = w.split(['[', '=']).next().unwrap_or("").trim_end_matches('+');
            if ZSH_TABLES.contains(&table) && (w.contains('[') || w.contains('=')) {
                return Some(code_why(&format!("`{table}[…]`, zsh's table of {table}, which runs what is put in it")));
            }
        }
        for &at in &cands {
            let cmd = words[at].as_str();
            let operands = &words[at + 1..];
            // a variable name given to a declaring builtin as an expansion: the shell reads a name with a
            // subscript (`a[$(cmd)]`) as code, so `declare "$v"=1` or `export "$v"` runs a file name in $v
            if NAME_BUILTINS.contains(&cmd) {
                let named = operands.iter().filter(|w| !w.starts_with(['-', '+'])).map(|w| w.split('=').next().unwrap_or(w));
                if named.into_iter().any(|n| n.contains(['$', '`', '('])) {
                    return Some(code_why(&format!("an expansion as the variable name for `{cmd}` (a name with a subscript runs as code)")));
                }
            }
            // zsh and ksh: `set -A name …` takes the array's name
            if cmd == "set" {
                if let Some(k) = operands.iter().position(|w| is_array_flag(w)) {
                    if operands.get(k + 1).is_some_and(|n| n.contains(['$', '`', '('])) {
                        return Some(code_why("an expansion as the array name for `set -A` (a name with a subscript runs as code)"));
                    }
                }
            }
            // ksh reads a bare variable name as arithmetic too (`shift n`, `ulimit -n n`)
            if matches!(cmd, "shift" | "ulimit") {
                let literal = |w: &str| w.bytes().all(|c| c.is_ascii_digit()) || matches!(w, "$?" | "$#" | "$$" | "unlimited" | "hard" | "soft");
                if operands.iter().any(|w| !w.starts_with('-') && !literal(w)) {
                    return Some(code_why(&format!("`{cmd}` with a variable or expression (ksh reads it as arithmetic)")));
                }
            }
            // these define or run text later (`alias a=$v`, `fc -e`, `enable -f`), or read a file
            // named by an expansion
            if matches!(cmd, "alias" | "fc" | "enable") {
                return Some(code_why(&format!("`{cmd}`, which defines or runs text as code")));
            }
            if matches!(cmd, "source" | ".") && operands.iter().any(|w| w.contains(['$', '`'])) {
                return Some(code_why(&format!("`{cmd}` with an expansion, which reads and runs a file chosen at run time")));
            }
        }
        if let Some(at) = words.iter().position(|w| NUMBER_BUILTINS.contains(&w.as_str())) {
            if words[at + 1..].iter().any(|w| w.contains('$') && !matches!(w.as_str(), "$?" | "$#" | "$$")) {
                return Some(code_why(&format!("`{}` with a variable (zsh and ksh read it as arithmetic)", words[at])));
            }
        }
    }
    let b = t.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'$' if b.get(i + 1) == Some(&b'{') => {
                // up to the first `}`; one that is missing, or a body that isn't plain, is refused
                let Some(close) = b[i + 2..].iter().position(|&c| c == b'}') else {
                    return Some(code_why("a `${` with no closing `}`"));
                };
                let body = &t[i + 2..i + 2 + close];
                if let Some(what) = brace_problem(body) {
                    return Some(code_why(what));
                }
                i += 2 + close;
            }
            b'[' if i > 0 => {
                let prev = b[i - 1];
                let end = b[i..].iter().position(|&c| c == b']').map_or(b.len(), |p| i + p);
                let inner = &t[i + 1..end.min(b.len())];
                let mut k = i;
                while k > 0 && ident(b[k - 1]) {
                    k -= 1;
                }
                // what the subscript hangs on: `$name[`, `${name}[`, `$1[`, `$@[` (zsh reads those as subscripts).
                // `${name[@]}` never gets here: its whole body was checked above.
                let on_param = (k < i && k > 0 && b[k - 1] == b'$') || prev == b'}' || (i > 1 && b"@*#?$".contains(&prev) && b[i - 2] == b'$');
                if on_param {
                    return Some(code_why("a subscript (`name[ … ]`, evaluated as arithmetic; only `${name[@]}` and `${name[*]}` are allowed)"));
                }
                if !on_param && k < i && !b[k].is_ascii_digit() && (inner.contains(['$', '`', '(', ')']) || inner.bytes().any(|c| c.is_ascii_alphabetic() || c == b'_')) {
                    return Some(code_why("a subscript (`name[ … ]`, evaluated as arithmetic)"));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Builtins that read their operand as code: an arithmetic expression, a variable name with an
/// array index (`x[$(cmd)]`), or a command. Quoting can't help there, the value itself is read.
/// `exit` and its kin read their operand as arithmetic in zsh, `shift` and `ulimit` in ksh,
/// `repeat` and `vared` are zsh's.
const CODE_BUILTINS: [&str; 18] = [
    "let", "eval", "trap", "read", "unset", "compgen", "complete", "mapfile", "readarray", "exit", "return", "break", "continue", "shift", "logout", "repeat", "vared", "ulimit",
];
/// Builtins whose operands are variable names (an `x[$(cmd)]` there runs), unless given as `name=value`.
/// Also zsh's `private`, `getln` and `getopts`, and ksh's `alarm`, which take a variable name too (a
/// placeholder as any of their operands is refused, R10 S-1).
const NAME_BUILTINS: [&str; 10] = ["declare", "typeset", "local", "export", "readonly", "integer", "private", "getopts", "getln", "alarm"];
/// Words that come before the command word in a command line.
const LEAD: [&str; 9] = ["!", "{", "then", "do", "else", "elif", "if", "while", "until"];
/// Words that run what follows them (`command -p declare …`, `env X=1 export …`): after one, any
/// later word of the command may be the command word.
/// zsh's `-` (a precommand modifier) and `coproc` (a reserved word) run what follows too.
const PREFIXES: [&str; 12] = ["command", "builtin", "exec", "env", "nohup", "time", "nice", "xargs", "noglob", "nocorrect", "-", "coproc"];
/// `NAME=value`, `NAME+=value` and `NAME[sub]=value` as a command prefix (R10 S-2).
fn is_assignment(w: &str) -> bool {
    w.find('=').is_some_and(|e| {
        let base = w[..e].trim_end_matches('+').split('[').next().unwrap_or("");
        !base.is_empty() && base.bytes().all(|x| x.is_ascii_alphanumeric() || x == b'_')
    })
}
/// Shells that read a script name as code (ksh93 runs the `[$(cmd)]` of a name before it fails to open it).
fn is_ksh(cmd: &str) -> bool {
    matches!(cmd.rsplit('/').next().unwrap_or(""), "ksh" | "ksh93" | "mksh" | "pdksh")
}
/// `-A`, `+A`, `-eA`: the flag of `set` that takes an array name (zsh and ksh).
fn is_array_flag(w: &str) -> bool {
    w.len() > 1 && w.starts_with(['-', '+']) && w[1..].bytes().all(|c| c.is_ascii_alphabetic()) && w.ends_with('A')
}
/// Test operators that read both sides as numbers (ksh and `[[` evaluate them as arithmetic).
const NUMERIC_TESTS: [&str; 6] = ["-eq", "-ne", "-lt", "-le", "-gt", "-ge"];

/// Why the placeholder at byte `at` goes where a builtin reads its value as code (the rest of the
/// error after the placeholder's name), or None. A best effort on the plain words of the command
/// it is in (from the last `;`, `&`, `|`, line break, `(`, `)` or backtick): `let`, `read`, `trap`,
/// `eval` and the like, a variable name for `declare`/`export`/…, `printf -v`, `[[`/`[`/`test`
/// with a numeric comparison or `-v`, and an array index (`a[{name}]`). Mirrored in templateCheck.ts.
fn operand_problem(template: &str, at: usize) -> Option<&'static str> {
    // placeholders as one control byte each (same length), so their braces are not the shell's
    let masked = mask_placeholders(template);
    let b = masked.as_bytes();
    let mut start = (0..at).rev().find(|&p| is_sep(b, p)).map_or(0, |p| p + 1);
    let mut end = (at..b.len()).find(|&p| is_sep(b, p)).unwrap_or(b.len());
    // inside `[[ … ]]`, `&`, `|`, `(` and `)` group tests and don't end the command: one test
    if let Some(open) = masked[..at].rfind("[[") {
        let word = (open == 0 || b[open - 1].is_ascii_whitespace() || is_sep(b, open - 1)) && b.get(open + 2).is_some_and(u8::is_ascii_whitespace);
        if word && !masked[open..at].contains("]]") {
            start = open;
            end = masked[at..].find("]]").map_or(b.len(), |p| at + p);
        }
    }
    // the words as the shell will see them: quotes and backslashes are gone
    let unquoted = |x: &str| x.chars().filter(|c| !matches!(c, '\'' | '"' | '\\')).collect::<String>();
    let before = unquoted(&masked[start..at]);
    let mut words = split_words(&before);
    // the part of the placeholder's own word before it ("" when it starts a word), and the word before
    let glued = !before.is_empty() && !before.ends_with(|c: char| c.is_ascii_whitespace());
    let cur = if glued { words.pop().unwrap_or_default() } else { String::new() };
    let prev = words.last().cloned().unwrap_or_default();
    let code = "goes where the shell reads the value as code (let, read, trap, eval, -eq, an array index…), and a file name could run there. Pass it as a plain argument instead.";
    // every command word the command can have (see `command_words`)
    for at in command_words(&words) {
        let cmd = words[at].as_str();
        if CODE_BUILTINS.contains(&cmd) {
            return Some(code);
        }
        if NAME_BUILTINS.contains(&cmd) && !cur.contains('=') {
            return Some(code);
        }
        // `set -A NAME` (zsh, ksh): the word after the flag is a variable name
        if cmd == "set" && is_array_flag(&prev) {
            return Some(code);
        }
        // ksh93 runs the `[$(cmd)]` of a script name before it opens it (R10 S-5)
        if is_ksh(cmd) {
            return Some(code);
        }
        if matches!(cmd, "printf" | "print") && prev == "-v" {
            return Some(code);
        }
        if matches!(cmd, "[[" | "[" | "test") {
            let all = unquoted(&masked[start..end]);
            if prev == "-v" || prev == "-R" || all.split_ascii_whitespace().any(|w| NUMERIC_TESTS.contains(&w)) {
                return Some(code);
            }
        }
    }
    // an unclosed `[` in its own word: an array index (`a[{name}]=1`)
    if cur.rfind('[').is_some_and(|o| !cur[o..].contains(']')) {
        return Some(code);
    }
    None
}

/// Whether `b[i]` ends a command: `;`, `|`, a line break, `(`, `)`, a backtick, `{`, `}`, and a `&`
/// that is not part of a redirection (`2>&1`, `&>x`; `>|` is a redirection too).
fn is_sep(b: &[u8], i: usize) -> bool {
    match b[i] {
        b';' | b'\n' | b'(' | b')' | b'`' | b'{' | b'}' => true,
        b'|' => !(i > 0 && b[i - 1] == b'>'),
        b'&' => !(i > 0 && matches!(b[i - 1], b'<' | b'>')) && b.get(i + 1) != Some(&b'>'),
        _ => false,
    }
}

/// The text with each placeholder (not the shell's `${word}`) turned into control bytes of the same
/// length, so what is left is the shell's own braces and words.
fn mask_placeholders(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        if t.as_bytes()[i] == b'{' && !t[..i].ends_with('$') {
            if let Some(w) = PLACEHOLDERS.iter().find(|w| t[i..].starts_with(&format!("{{{w}}}"))) {
                out.extend(std::iter::repeat('\u{1}').take(w.len() + 2));
                i += w.len() + 2;
                continue;
            }
        }
        let ch = t[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// The commands of `t`, each as its words (see [`is_sep`] and [`split_words`]).
fn commands(t: &str) -> Vec<Vec<String>> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    for i in 0..b.len() {
        if is_sep(b, i) {
            // a backtick stays with the words before it, as the `$` of `$(` does, so `export \`cmd\``
            // still shows an expansion as the variable name
            out.push(split_words(&t[from..i + (b[i] == b'`') as usize]));
            from = i + 1;
        }
    }
    out.push(split_words(&t[from..]));
    out
}

/// `2>&1`, `>file`, `<<EOF`, `&>x`: a word that is a redirection.
fn is_redirect(w: &str) -> bool {
    let r = w.trim_start_matches(|c: char| c.is_ascii_digit());
    let r = r.strip_prefix('&').unwrap_or(r);
    r.starts_with(['<', '>'])
}

/// A redirection written apart from its target (`>` then `file`), so the next word belongs to it.
fn bare_redirect(w: &str) -> bool {
    matches!(w.trim_start_matches(|c: char| c.is_ascii_digit()), "<" | ">" | ">>" | ">|" | "<>" | ">&" | "<&" | "<<" | "<<<" | "<<-" | "&>" | "&>>")
}

/// Blank-separated words, with a redirection that is glued to a word (`shift>/dev/null`) split
/// off, as a shell reads it.
fn split_words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_whitespace() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if matches!(c, '<' | '>') && !cur.is_empty() && cur != "&" && !cur.bytes().all(|x| x.is_ascii_digit()) && !is_redirect(&cur) {
            out.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Where the command word of a command is: the first word after keywords, redirections (with their
/// targets) and `NAME=value` assignments. After a prefix (`command -p`, `env`, `nice -n 5`…) every
/// later word counts, since which one is the command depends on the prefix's own flags.
fn command_words(words: &[String]) -> Vec<usize> {
    let mut k = 0;
    while k < words.len() {
        let w = words[k].as_str();
        if is_redirect(w) {
            k += if bare_redirect(w) { 2 } else { 1 };
        } else if LEAD.contains(&w) || is_assignment(w) {
            k += 1;
        } else {
            break;
        }
    }
    match words.get(k) {
        None => Vec::new(),
        Some(w) if PREFIXES.contains(&w.as_str()) => (k..words.len()).collect(),
        Some(_) => vec![k],
    }
}

/// Whether the `(` at byte `i` is NOT where a command starts (a subshell, a process substitution,
/// an array value `name=(…)` in front of the command or for `declare` and kin): zsh reads such a
/// `(` after a word as glob qualifiers (R9 S-7).
fn glob_paren(t: &str, i: usize) -> bool {
    let b = t.as_bytes();
    let mut j = i;
    while j > 0 && matches!(b[j - 1], b' ' | b'\t') {
        j -= 1;
    }
    if j == 0 || matches!(b[j - 1], b';' | b'&' | b'|' | b'(' | b')' | b'\n' | b'\r' | b'`' | b'{' | b'<' | b'>' | b'$') {
        return false;
    }
    let ws = (0..j).rev().find(|&p| b[p].is_ascii_whitespace() || is_sep(b, p)).map_or(0, |p| p + 1);
    let word = &t[ws..j];
    if LEAD.contains(&word) || PREFIXES.contains(&word) {
        return false;
    }
    if b[j - 1] == b'=' {
        let seg = (0..ws).rev().find(|&p| is_sep(b, p)).map_or(0, |p| p + 1);
        let words = split_words(&t[seg..ws]);
        return command_words(&words).first().is_some_and(|&c| !NAME_BUILTINS.contains(&words[c].as_str()));
    }
    true
}

/// The command lines to run: one per item when the template uses `{path}`, `{name}`, `{ext}` or
/// `{stem}`, else one for all of them. `{paths}` is every item, `{dir}` the folder. `windows`:
/// the paths are on this computer under Windows (`\` separates there, see [`name_of`]).
pub fn expand(template: &str, items: &[Item], dir: &str, windows: bool) -> Vec<String> {
    let paths = items.iter().map(|i| arg(&i.path)).collect::<Vec<_>>().join(" ");
    let common = |w: &str| match w {
        "paths" => Some(paths.clone()),
        "dir" => Some(arg(dir)),
        _ => None,
    };
    if !PER_ITEM.iter().any(|w| uses(template, w)) {
        return vec![substitute(template, common)];
    }
    items
        .iter()
        .map(|it| {
            let name = name_of(&it.path, windows);
            let (stem, ext) = split_ext(name, it.is_dir);
            substitute(template, |w| match w {
                "path" => Some(arg(&it.path)),
                "name" => Some(arg(name)),
                "stem" => Some(arg(stem)),
                "ext" => Some(quote(ext)),
                _ => common(w),
            })
        })
        .collect()
}

// ---------------------------------------------------------------- output

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'a> {
    run_id: &'a str,
    /// "out", "err", or "note" (the app's own lines: truncation, the next command)
    stream: &'a str,
    text: &'a str,
}

/// Passes output on as events, whole UTF-8 characters only, up to [`OUTPUT_LIMIT`].
struct Sink<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    run_id: &'a str,
    sent: usize,
    truncated: bool,
    /// an unfinished UTF-8 character at the end of the last chunk, per stream
    carry: [Vec<u8>; 2],
}

impl<'a, R: Runtime> Sink<'a, R> {
    fn new(app: &'a AppHandle<R>, run_id: &'a str) -> Self {
        Self { app, run_id, sent: 0, truncated: false, carry: [Vec::new(), Vec::new()] }
    }

    fn note(&self, text: &str) {
        let _ = self.app.emit("custom-action-output", Output { run_id: self.run_id, stream: "note", text });
    }

    fn push(&mut self, stderr: bool, bytes: &[u8]) {
        if self.truncated {
            return;
        }
        let carry = &mut self.carry[stderr as usize];
        carry.extend_from_slice(bytes);
        let (text, keep) = utf8_prefix(carry);
        let mut text = text;
        if self.sent + text.len() > OUTPUT_LIMIT {
            let mut cut = OUTPUT_LIMIT.saturating_sub(self.sent);
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            self.truncated = true;
        }
        self.sent += text.len();
        if !text.is_empty() {
            let _ = self.app.emit("custom-action-output", Output { run_id: self.run_id, stream: if stderr { "err" } else { "out" }, text: &text });
        }
        *carry = keep;
        if self.truncated {
            self.note("\n[Output stopped at 1 MB. The command keeps running.]\n");
        }
    }
}

/// The text of the complete characters in `bytes`, and the bytes of an unfinished last one.
fn utf8_prefix(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) if e.error_len().is_none() && bytes.len() - e.valid_up_to() < 4 => {
            let (done, rest) = bytes.split_at(e.valid_up_to());
            (String::from_utf8_lossy(done).into_owned(), rest.to_vec())
        }
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), Vec::new()),
    }
}

// ---------------------------------------------------------------- running

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    /// also the key of its Stop flag (Activity's Stop button sends the same id)
    pub run_id: String,
    pub template: String,
    /// over SSH on the connection's server; else on this computer
    pub on_server: bool,
    pub profile_id: String,
    /// server runs: keys of the connection (made absolute here); local runs: absolute paths
    pub items: Vec<Item>,
    pub dir: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunEnd {
    /// the last failing command's exit status, else 0; None when it was stopped or killed
    pub code: Option<i32>,
    pub stopped: bool,
    pub truncated: bool,
    /// how many command lines ran (one per item, or one)
    pub commands: usize,
}

#[tauri::command]
pub async fn custom_action_run(app: AppHandle, state: State<'_, AppState>, spec: RunSpec) -> Result<RunEnd, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(spec.run_id.clone(), cancel.clone());
    // the copies it works on stay while it runs (it may get to the last one after hours)
    let _reading = (!spec.on_server).then(|| crate::files::open_copies::in_use(spec.items.iter().map(|i| i.path.as_str()).chain([spec.dir.as_str()])));
    let r = run(&app, &state, &spec, &cancel).await;
    state.cancels.lock().await.remove(&spec.run_id);
    r
}

#[tauri::command]
pub async fn custom_action_stop(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().await.get(&run_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// What the template turns into for these items (the editor's preview).
#[tauri::command]
pub fn custom_action_preview(template: String, items: Vec<Item>, dir: String) -> Result<Vec<String>, String> {
    check_template(&template)?;
    Ok(expand(&template, &items, &dir, cfg!(windows)))
}

/// The message for an item (or the folder) whose name can't be passed to a shell on a server (see
/// [`plain_text`]); None when every name can.
fn unquotable(items: &[Item], dir: &str) -> Option<String> {
    let bad = items.iter().map(|i| i.path.as_str()).chain([dir]).find(|p| !plain_text(p))?;
    Some(format!("“{}” has a line break or another control character in its name, so it can't be passed to a command.", name_of(bad, false).escape_debug()))
}

async fn run<R: Runtime>(app: &AppHandle<R>, state: &AppState, spec: &RunSpec, cancel: &AtomicBool) -> Result<RunEnd, String> {
    let mut sink = Sink::new(app, &spec.run_id);
    check_template(&spec.template)?;
    let mut end = RunEnd { code: Some(0), ..Default::default() };
    if spec.on_server {
        let sftp = crate::storage::registry::open_sftp(app, state, &spec.profile_id).await?;
        let r = async {
            let mut items = Vec::with_capacity(spec.items.len());
            for it in &spec.items {
                items.push(Item { path: sftp.remote_path(&it.path).await?, is_dir: it.is_dir });
            }
            let dir = sftp.remote_path(&spec.dir).await?;
            if let Some(bad) = unquotable(&items, &dir) {
                return Err(crate::storage::StorageError::other(bad));
            }
            let lines = expand(&spec.template, &items, &dir, false);
            for (i, line) in lines.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    end.stopped = true;
                    break;
                }
                if lines.len() > 1 {
                    sink.note(&format!("[{} of {}]\n", i + 1, lines.len()));
                }
                // in the folder on screen; nothing runs if it isn't there
                let r = sftp.exec(&format!("cd {} && {line}", quote(&dir)), cancel, |err, b| sink.push(err, b)).await?;
                end.commands += 1;
                if r.stopped {
                    end.stopped = true;
                    break;
                }
                match r.code {
                    Some(0) => {}
                    c => end.code = c.map(|c| c as i32),
                }
            }
            Ok::<_, crate::storage::StorageError>(())
        }
        .await;
        sftp.disconnect().await;
        r?;
    } else {
        let lines = expand(&spec.template, &spec.items, &spec.dir, cfg!(windows));
        for (i, line) in lines.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                end.stopped = true;
                break;
            }
            if lines.len() > 1 {
                sink.note(&format!("[{} of {}]\n", i + 1, lines.len()));
            }
            let (code, stopped) = local::run(line, &spec.dir, cancel, |err, b| sink.push(err, b)).await?;
            end.commands += 1;
            if stopped {
                end.stopped = true;
                break;
            }
            if code != Some(0) {
                end.code = code;
            }
        }
    }
    if end.stopped {
        end.code = None;
    }
    end.truncated = sink.truncated;
    Ok(end)
}

#[cfg(desktop)]
mod local {
    use std::{
        path::Path,
        process::Stdio,
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    use tokio::{
        io::{AsyncRead, AsyncReadExt},
        process::Command,
    };

    /// Shells known to read [`super::quote`] and the template the way [`super::check_template`]
    /// does (POSIX sh syntax).
    #[cfg(unix)]
    const POSIX_SHELLS: [&str; 7] = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"];

    /// The shell that runs a line: the user's (`$SHELL`) when it is a POSIX shell, else /bin/sh.
    /// An allow-list: csh and tcsh expand `!` even inside single quotes, and nushell, PowerShell,
    /// xonsh, elvish, fish and the like read quotes or the template's syntax differently, so a
    /// name could end the quoting there.
    #[cfg(unix)]
    pub fn user_shell(env: Option<String>) -> String {
        env.filter(|s| s.starts_with('/') && Path::new(s).exists())
            .filter(|s| s.rsplit('/').next().is_some_and(|n| POSIX_SHELLS.contains(&n)))
            .unwrap_or_else(|| "/bin/sh".into())
    }

    /// The PATH in an `env` listing: its last `PATH=` line, absolute folders only. None when it
    /// has none.
    #[cfg(unix)]
    pub fn path_from_env(out: &str) -> Option<String> {
        let line = out.lines().rev().find_map(|l| l.strip_prefix("PATH="))?;
        let keep: Vec<&str> = line.split(':').filter(|d| d.starts_with('/')).collect();
        (!keep.is_empty()).then(|| keep.join(":"))
    }

    /// The PATH a login of `shell` sets up (fish, nushell, csh…: its config is where Homebrew and
    /// the like are added), asked once per shell by having it run `env`. None when it couldn't
    /// say within a few seconds.
    #[cfg(unix)]
    pub async fn login_path(shell: &str) -> Option<String> {
        static PATHS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Option<String>>>> = std::sync::LazyLock::new(Default::default);
        if let Some(p) = PATHS.lock().unwrap().get(shell) {
            return p.clone();
        }
        // csh and tcsh take -l only on its own
        let args: &[&str] = if shell.ends_with("csh") { &["-c", "/usr/bin/env"] } else { &["-l", "-c", "/usr/bin/env"] };
        let out = Command::new(shell).args(args).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).output();
        let path = match tokio::time::timeout(Duration::from_secs(8), out).await {
            Ok(Ok(o)) => path_from_env(&String::from_utf8_lossy(&o.stdout)),
            _ => None,
        };
        PATHS.lock().unwrap().insert(shell.to_string(), path.clone());
        path
    }

    /// The user's shell as a login shell (so PATH has Homebrew and the like, as in Terminal). Any
    /// other login shell (fish, nushell…): /bin/sh, with the PATH that shell sets up.
    #[cfg(unix)]
    async fn shell(line: &str) -> Command {
        let user = std::env::var("SHELL").ok();
        let sh = user_shell(user.clone());
        let mut c = Command::new(&sh);
        let other = user.filter(|u| *u != sh && u.starts_with('/') && Path::new(u).exists());
        match other {
            Some(u) => match login_path(&u).await {
                // not a login sh: its profile (path_helper on a Mac) would reorder that PATH
                Some(path) => {
                    c.args(["-c", line]).env("PATH", path);
                }
                None => {
                    let mut path = std::env::var("PATH").unwrap_or_default();
                    for d in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
                        if !path.split(':').any(|p| p == d) {
                            path = if path.is_empty() { d.to_string() } else { format!("{path}:{d}") };
                        }
                    }
                    c.args(["-l", "-c", line]).env("PATH", path);
                }
            },
            None => {
                c.args(["-l", "-c", line]);
            }
        }
        // its own process group, so Stop ends what it started too
        c.process_group(0);
        c
    }

    /// Windows: the sh that Git for Windows installs (the quoting is POSIX), with no console
    /// window of its own.
    #[cfg(windows)]
    async fn shell(line: &str) -> Command {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("sh");
        c.args(["-c", line]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }

    /// Windows has no process groups: the shell and everything it started, ended at once.
    #[cfg(windows)]
    fn kill_tree(child: &tokio::process::Child) {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        if let Some(pid) = child.id() {
            let exe = std::env::var("SystemRoot").map_or_else(|_| r"C:\Windows\System32\taskkill.exe".to_string(), |r| format!(r"{r}\System32\taskkill.exe"));
            let _ = std::process::Command::new(exe)
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }

    #[cfg(unix)]
    fn signal(child: &tokio::process::Child, sig: i32) {
        if let Some(pid) = child.id() {
            // SAFETY: plain syscall on the group the shell leads
            unsafe { libc::killpg(pid as i32, sig) };
        }
    }

    fn terminate(child: &mut tokio::process::Child, hard: bool) {
        #[cfg(unix)]
        signal(child, if hard { libc::SIGKILL } else { libc::SIGTERM });
        #[cfg(windows)]
        kill_tree(child);
        #[cfg(not(unix))]
        let _ = hard;
        if hard || cfg!(not(unix)) {
            let _ = child.start_kill();
        }
    }

    /// Stop asked: SIGTERM to the group, SIGKILL two seconds later.
    fn check(child: &mut tokio::process::Child, cancel: &AtomicBool, stopped_at: &mut Option<tokio::time::Instant>) {
        if !cancel.load(Ordering::Relaxed) {
            return;
        }
        match *stopped_at {
            None => {
                *stopped_at = Some(tokio::time::Instant::now());
                terminate(child, false);
            }
            Some(t) if t.elapsed() > Duration::from_secs(2) => terminate(child, true),
            Some(_) => {}
        }
    }

    /// Reads `a` and `b` to their end, keeping nothing.
    async fn drain(a: Option<impl AsyncRead + Unpin>, b: Option<impl AsyncRead + Unpin>) {
        async fn one(r: Option<impl AsyncRead + Unpin>) {
            let Some(mut r) = r else { return };
            let mut buf = [0u8; 4096];
            while matches!(r.read(&mut buf).await, Ok(n) if n > 0) {}
        }
        tokio::join!(one(a), one(b));
    }

    /// Runs one command line in `dir`: (exit code, stopped).
    pub async fn run(line: &str, dir: &str, cancel: &AtomicBool, mut on_data: impl FnMut(bool, &[u8])) -> Result<(Option<i32>, bool), String> {
        let mut cmd = shell(line).await;
        if !dir.is_empty() && Path::new(dir).is_dir() {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the shell. {e}"))?;
        let mut out = child.stdout.take().expect("piped");
        let mut err = child.stderr.take().expect("piped");
        let (mut ob, mut eb) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);
        let (mut out_open, mut err_open) = (true, true);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let mut stopped_at: Option<tokio::time::Instant> = None;
        // the shell's exit status once it has ended, and when output last came (or it ended)
        let mut exited: Option<(std::process::ExitStatus, tokio::time::Instant)> = None;
        let mut quiet_since = tokio::time::Instant::now();
        while out_open || err_open {
            tokio::select! {
                r = out.read(&mut ob), if out_open => match r {
                    Ok(0) | Err(_) => out_open = false,
                    Ok(n) => {
                        quiet_since = tokio::time::Instant::now();
                        on_data(false, &ob[..n]);
                    }
                },
                r = err.read(&mut eb), if err_open => match r {
                    Ok(0) | Err(_) => err_open = false,
                    Ok(n) => {
                        quiet_since = tokio::time::Instant::now();
                        on_data(true, &eb[..n]);
                    }
                },
                _ = tick.tick() => {
                    check(&mut child, cancel, &mut stopped_at);
                    // stopped and the pipes still open after a while (something kept them): leave
                    if stopped_at.is_some_and(|t| t.elapsed() > Duration::from_secs(4)) {
                        break;
                    }
                    // the shell ended but something it started in the background (`editor {path} &`,
                    // a daemon) still holds the pipes: done once that has been quiet a moment, or
                    // two seconds after the shell ended at the latest
                    if exited.is_none() {
                        if let Ok(Some(s)) = child.try_wait() {
                            exited = Some((s, tokio::time::Instant::now()));
                        }
                    }
                    if let Some((_, at)) = exited {
                        if at.max(quiet_since).elapsed() > Duration::from_millis(300) || at.elapsed() > Duration::from_secs(2) {
                            break;
                        }
                    }
                }
            }
        }
        // something started in the background still holds the pipes: keep reading them (and
        // throwing the output away) until it closes them, or its next write would kill it (SIGPIPE)
        if out_open || err_open {
            tokio::spawn(drain(out_open.then_some(out), err_open.then_some(err)));
        }
        let status = match exited {
            Some((s, _)) => s,
            None => loop {
                tokio::select! {
                    s = child.wait() => break s.map_err(|e| e.to_string())?,
                    _ = tick.tick() => check(&mut child, cancel, &mut stopped_at),
                }
            },
        };
        Ok((status.code(), stopped_at.is_some()))
    }
}

#[cfg(not(desktop))]
mod local {
    use std::sync::atomic::AtomicBool;

    pub async fn run(_line: &str, _dir: &str, _cancel: &AtomicBool, _on_data: impl FnMut(bool, &[u8])) -> Result<(Option<i32>, bool), String> {
        Err("Actions run on a computer.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(p: &str) -> Item {
        Item { path: p.into(), is_dir: p.ends_with('/') }
    }

    /// What `sh` makes of a command line: its words, one per line (needs /bin/sh).
    #[cfg(unix)]
    fn words(line: &str) -> Vec<String> {
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(format!("for w in {line}; do printf '%s\\0' \"$w\"; done")).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().split_terminator('\0').map(String::from).collect()
    }

    const NASTY: [&str; 9] = [
        "/tmp/a b.jpg",
        "/tmp/it's.jpg",
        "/tmp/$(touch pwned).jpg",
        "/tmp/`id`.jpg",
        "/tmp/new\nline.jpg",
        "/tmp/semi;colon&amp|pipe>out.jpg",
        "/tmp/'\"'\"mixed\\back.jpg",
        "/tmp/${HOME}*?[x].jpg",
        "/tmp/é ü 漢字.jpg",
    ];

    #[test]
    fn quote_wraps_in_single_quotes() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote(""), "''");
        // a backslash never sits inside the quotes (fish reads `\'` there as a quote)
        assert_eq!(quote(r"a\b"), r"'a'\\'b'");
        assert_eq!(quote(r"\'; touch x; echo \"), r"''\\''\''; touch x; echo '\\''");
    }

    /// Between the single quotes there is never a quote or a backslash, so fish, csh and POSIX
    /// shells all end the word where it ends.
    #[test]
    fn quoted_text_holds_nothing_any_shell_reads() {
        for p in NASTY.iter().copied().chain([r"\'; cd; touch pwned; echo \", r"x\\'\"]) {
            let q = quote(p);
            let mut inside = false;
            let mut chars = q.chars();
            while let Some(c) = chars.next() {
                match (inside, c) {
                    (false, '\'') | (true, '\'') => inside = !inside,
                    (false, '\\') => assert!(matches!(chars.next(), Some('\\' | '\'')), "{q}"),
                    (true, '\\') => panic!("backslash inside quotes: {q}"),
                    (false, c) => panic!("{c:?} outside quotes: {q}"),
                    _ => {}
                }
            }
            assert!(!inside, "{q}");
        }
    }

    /// The real fish, when installed: what it reads back is the name.
    #[cfg(unix)]
    #[test]
    fn fish_reads_the_quoting_back() {
        let Some(fish) = ["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"].into_iter().find(|p| std::path::Path::new(p).exists()) else { return };
        for p in NASTY.iter().copied().chain([r"\'; touch /tmp/kybl-fish-pwned; echo \"]) {
            let out = std::process::Command::new(fish).arg("-c").arg(format!("printf %s {}", quote(p))).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), p);
        }
        assert!(!std::path::Path::new("/tmp/kybl-fish-pwned").exists());
    }

    /// The cases shared with the editor's check (src/actions/lib/templateCheck.ts).
    #[test]
    fn template_vectors() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../tests/actions/template-vectors.json")).unwrap();
        for case in v["bad"].as_array().unwrap() {
            let (t, want) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
            let err = check_template(t).expect_err(t);
            assert!(err.contains(want), "{t:?}: {err}");
        }
        for ok in v["ok"].as_array().unwrap() {
            let t = ok.as_str().unwrap();
            assert!(check_template(t).is_ok(), "{t:?}: {:?}", check_template(t));
        }
        assert!(check_template(r#"x "{path}""#).unwrap_err().starts_with("{path} is inside quotes"));
    }

    /// The real shells agree with the vectors: in each `bad` case that the checker refused for
    /// `${ … }`, `$'…'` or arithmetic, a name with `$(touch …)` does run (so refusing is right).
    #[cfg(unix)]
    #[test]
    fn refused_constructs_really_run_names() {
        let dir = std::env::temp_dir().join(format!("kybl-tpl-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let evil = format!("{}/$(touch {})", dir.display(), marker.display());
        for t in [r#"echo "${x:-"{path}"}""#, r"echo $'\' {path} '", "echo $(( 1 + {path} ))"] {
            assert!(check_template(t).is_err(), "{t}");
            for sh in ["/bin/bash", "/bin/zsh"].into_iter().filter(|p| std::path::Path::new(p).exists()) {
                let _ = std::fs::remove_file(&marker);
                let line = expand(t, &[item(&evil)], "/tmp", false).remove(0);
                let _ = std::process::Command::new(sh).arg("-c").arg(&line).output().unwrap();
                assert!(marker.exists(), "{sh}: {t} did not run the name, the test is stale");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round-5 holes, each refused now, checked against the shells that read them that way when
    /// they are installed: `$$(`, `$'…\'…'` in dash, `>&word` in bash 3.2, `)` in `${ … }`
    /// inside `$( … )` in bash 3.2, and builtins that read their operand as code.
    #[cfg(unix)]
    #[test]
    fn round5_refusals_really_run_names() {
        let dir = std::env::temp_dir().join(format!("kybl-tpl5-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        // relative: `{name}` is the last part of the path (run in `dir`)
        let (subst, index) = ("x$(touch pwned)y", "x[$(touch pwned)]");
        let bash3 = std::process::Command::new("/bin/bash").arg("-c").arg("echo $BASH_VERSION").output().is_ok_and(|o| o.stdout.starts_with(b"3."));
        let cases: Vec<(&str, &str, Vec<&str>)> = vec![
            (r#"echo "$$(echo {name})""#, subst, vec!["/bin/bash", "/bin/zsh", "/bin/dash"]),
            (r"echo $'it\'s' {name} '", subst, vec!["/bin/dash"]),
            ("echo hi >&{name}", subst, if bash3 { vec!["/bin/bash"] } else { vec![] }),
            (r#"echo "$(echo ${x:-)} {name})""#, subst, if bash3 { vec!["/bin/bash"] } else { vec![] }),
            ("[[ 5 -eq {name} ]]", index, vec!["/bin/bash"]),
            ("let n={name}", index, vec!["/bin/bash"]),
            // round 6: a variable set from the placeholder and used in arithmetic later
            ("n={name}; echo $((n+1))", index, vec!["/bin/bash"]),
            ("declare -i n={name}", index, vec!["/bin/bash"]),
            // round 7: substring offsets, indirect expansion, a subscript read by `read`, `trap` and PS4
            ("n={name}; echo ${HOME:$n}", index, vec!["/bin/bash"]),
            ("n={name}; echo ${!n}", index, vec!["/bin/bash"]),
            (r#"n={name}; read -r "x[$n]" <<<1"#, index, vec!["/bin/bash"]),
            (r#"n={name}; trap "echo $n" EXIT"#, subst, vec!["/bin/bash", "/bin/dash"]),
            ("n={name}; PS4=$n; set -x; echo hi", subst, vec!["/bin/bash"]),
        ];
        for (t, name, shells) in cases {
            assert!(check_template(t).is_err(), "{t}");
            for sh in shells.into_iter().filter(|p| std::path::Path::new(p).exists()) {
                let _ = std::fs::remove_file(&marker);
                let line = expand(t, &[item(&format!("{}/{name}", dir.display()))], &dir.to_string_lossy(), false).remove(0);
                let _ = std::process::Command::new(sh).arg("-c").arg(&line).current_dir(&dir).stderr(std::process::Stdio::null()).output().unwrap();
                assert!(marker.exists(), "{sh}: {t} did not run the name, the test is stale");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round-8 holes, each refused now: a variable holding the name used as a variable NAME,
    /// assignments to variables the shell evaluates, ksh `shift`/`ulimit` operands, `>&$v`, and a
    /// continuation carrying the `>&` word to the next line. Each really runs the name in the
    /// shells listed (when installed), so the refusals are not guesses.
    #[cfg(unix)]
    #[test]
    fn round8_refusals_really_run_names() {
        let dir = std::env::temp_dir().join(format!("kybl-tpl8-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let (subst, index) = ("x$(touch pwned)y", "x[$(touch pwned)]");
        let bash3 = std::process::Command::new("/bin/bash").arg("-c").arg("echo $BASH_VERSION").output().is_ok_and(|o| o.stdout.starts_with(b"3."));
        let b3 = |s: Vec<&'static str>| if bash3 { s } else { vec![] };
        let cases: Vec<(&str, &str, Vec<&str>)> = vec![
            (r#"v={name}; export "$v""#, index, vec!["/bin/zsh"]),
            (r#"v={name}; typeset +x "$v""#, index, vec!["/bin/zsh"]),
            (r#"v={name}; declare "$v"=1"#, index, b3(vec!["/bin/bash"])),
            (r#"v={name}; typeset "$v=1""#, index, b3(vec!["/bin/bash"])),
            ("OPTIND={name}", index, b3(vec!["/bin/bash", "/bin/sh"])),
            ("v={name}; RANDOM=$v", index, vec!["/bin/ksh"]),
            ("n={name}; shift n", index, vec!["/bin/ksh"]),
            ("n={name}; ulimit -n n", index, vec!["/bin/ksh"]),
            ("ENV={name} sh -ic true", subst, b3(vec!["/bin/bash"])),
            ("v={name}; echo hi >&$v", subst, b3(vec!["/bin/sh"])),
            ("echo hi >&\\\n  {name}", subst, b3(vec!["/bin/bash", "/bin/sh"])),
            // refused all the same; the `2>&word` form is not read twice by these shells, so no run here
            ("echo hi 2>&\\\n\t{name}", subst, vec![]),
        ];
        for (t, name, shells) in cases {
            assert!(check_template(t).is_err(), "{t}");
            for sh in shells.into_iter().filter(|p| std::path::Path::new(p).exists()) {
                let _ = std::fs::remove_file(&marker);
                let line = expand(t, &[item(&format!("{}/{name}", dir.display()))], &dir.to_string_lossy(), false).remove(0);
                run_limited(sh, &line, &dir);
                assert!(marker.exists(), "{sh}: {t} did not run the name, the test is stale");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round-9 holes, each refused now and each really run by the shells listed (when installed,
    /// every run limited to 5 s with its process group killed): a comment ending in a backslash
    /// hiding a quote, command words behind `(`, `$(`, `case`, redirections and `command -p`,
    /// the integer variables HISTCMD/JOBMAX/PPID, zsh glob qualifiers, `alias` and `functions[1]`.
    #[cfg(unix)]
    #[test]
    fn round9_refusals_really_run_names() {
        let dir = std::env::temp_dir().join(format!("kybl-tpl9-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let (subst, index) = ("x$(touch pwned)y", "x[$(touch pwned)]");
        let bash3 = std::process::Command::new("/bin/bash").arg("-c").arg("echo $BASH_VERSION").output().is_ok_and(|o| o.stdout.starts_with(b"3."));
        let b3 = |s: Vec<&'static str>| if bash3 { s } else { vec![] };
        let all = vec!["/bin/bash", "/bin/sh", "/bin/zsh", "/bin/ksh", "/bin/dash"];
        let cases: Vec<(&str, &str, Vec<&str>)> = vec![
            ("echo hi # x \\\n'\necho {path}\n'", subst, all.clone()),
            ("echo hi # x \\\n\"\necho {path}\n\"", subst, all),
            ("v={name}; (OPTIND=$v)", index, b3(vec!["/bin/bash", "/bin/sh"])),
            ("v={name}; echo $(OPTIND=$v)", index, b3(vec!["/bin/bash"])),
            ("v={name}; ( export \"$v\" )", index, vec!["/bin/zsh"]),
            ("v={name}; echo $(export \"$v\")", index, vec!["/bin/zsh"]),
            ("v={name}; case x in x) export \"$v\";; esac", index, vec!["/bin/zsh"]),
            ("v={name}; >/dev/null export \"$v\"", index, vec!["/bin/zsh"]),
            ("v={name}; function f { export \"$v\"; }; f", index, vec!["/bin/zsh"]),
            ("v={name}; command -p declare \"$v\"=1", index, b3(vec!["/bin/bash"])),
            ("n={name}; (shift n)", index, vec!["/bin/ksh"]),
            ("export 2>&1 {name}", index, vec!["/bin/zsh"]),
            (">/dev/null shift {name}", index, vec!["/bin/ksh"]),
            ("shift>/dev/null {name}", index, vec!["/bin/ksh"]),
            ("v={name}; HISTCMD=$v", index, vec!["/bin/ksh"]),
            ("v={name}; JOBMAX=$v", index, vec!["/bin/ksh"]),
            ("v={name}; PPID=$v", index, vec!["/bin/ksh"]),
            ("echo x({name})", index, vec!["/bin/zsh"]),
            ("echo a ({name})", index, vec!["/bin/zsh"]),
            ("echo a list=({name})", index, vec!["/bin/zsh"]),
            ("v={name}; alias a=$v\na", subst, vec!["/bin/sh"]),
            ("v={name}; functions[1]=$v; 1", subst, vec!["/bin/zsh"]),
        ];
        for (t, name, shells) in cases {
            assert!(check_template(t).is_err(), "{t}");
            for sh in shells.into_iter().filter(|p| std::path::Path::new(p).exists()) {
                let _ = std::fs::remove_file(&marker);
                let line = expand(t, &[item(&format!("{}/{name}", dir.display()))], &dir.to_string_lossy(), false).remove(0);
                run_limited(sh, &line, &dir);
                assert!(marker.exists(), "{sh}: {t:?} did not run the name, the test is stale");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round-10 holes (builtins that take a name, `+=` and `a[0]=` prefixes, `-` and `coproc`,
    /// `OPTIND[0]=`, an escaped `#`, ksh script names), each refused now and each really run by
    /// the shells listed when installed (every run limited to 5 s, process group killed).
    #[cfg(unix)]
    #[test]
    fn round10_refusals_really_run_names() {
        let dir = std::env::temp_dir().join(format!("kybl-tpl10-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let index = "a[$(touch pwned)]";
        let bash3 = std::process::Command::new("/bin/bash").arg("-c").arg("echo $BASH_VERSION").output().is_ok_and(|o| o.stdout.starts_with(b"3."));
        let cases: Vec<(&str, &str, Vec<&str>)> = vec![
            ("private {name}", index, vec!["/bin/zsh"]),
            ("set -A {name} x", index, vec!["/bin/zsh"]),
            ("x+=1 typeset {name}", index, vec!["/bin/zsh"]),
            ("true | - export {name}", index, vec!["/bin/zsh"]),
            ("OPTIND[0]={name}", index, if bash3 { vec!["/bin/bash"] } else { vec![] }),
            ("ksh {name}", index, vec!["/bin/ksh"]),
        ];
        for (t, name, shells) in cases {
            assert!(check_template(t).is_err(), "{t}");
            for sh in shells.into_iter().filter(|p| std::path::Path::new(p).exists()) {
                let _ = std::fs::remove_file(&marker);
                let line = expand(t, &[item(&format!("{}/{name}", dir.display()))], &dir.to_string_lossy(), false).remove(0);
                run_limited(sh, &line, &dir);
                assert!(marker.exists(), "{sh}: {t:?} did not run the name, the test is stale");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Runs `line` in `sh` for at most 5 seconds; at the deadline the whole process group is
    /// killed, so a shell that loops (or a child it started) never outlives the test.
    #[cfg(unix)]
    fn run_limited(sh: &str, line: &str, dir: &std::path::Path) {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new(sh)
            .arg("-c")
            .arg(line)
            .current_dir(dir)
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // the group, whether or not the shell itself has ended (a no-op when nothing is left). Not
        // through the `kill` program: procps's `kill -KILL -PID` signals group 0, its own, which
        // took the test run (and the CI runner) down with it
        let pgid = child.id() as libc::pid_t;
        if pgid > 1 {
            // SAFETY: plain syscall on the group this test started
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Server scripts never carry a line break or control character (csh would end the command
    /// there, see `plain_text`), and run with an absolute-only PATH.
    #[test]
    fn server_scripts_refuse_control_characters() {
        assert!(sh_c("echo ok").is_some());
        for bad in ["a\nb", "a\rb", "a\u{1b}b", "a\u{85}b", "a\u{7f}b"] {
            assert!(sh_c(&format!("ls -- {}", quote(bad))).is_none(), "{bad:?}");
            assert!(!plain_text(bad));
        }
        let it = [item("/srv/new\nline.txt")];
        assert!(unquotable(&it, "/srv").unwrap().contains("line break"));
        assert!(unquotable(&[item("/srv/ok.txt")], "/srv/x\ny").is_some());
        assert!(unquotable(&[item("/srv/ok 'it'.txt")], "/srv").is_none());
    }

    /// csh and tcsh, when installed: every name without a control character reads back as itself
    /// through `sh_c`, and a newline (which would break out there) never gets that far.
    #[cfg(unix)]
    #[test]
    fn csh_reads_the_quoting_back() {
        for csh in ["/bin/tcsh", "/bin/csh"].into_iter().filter(|p| std::path::Path::new(p).exists()) {
            for p in NASTY.iter().copied().filter(|p| plain_text(p)).chain([r"\'; touch /tmp/kybl-csh-pwned; echo \", "a b ~ {x,y} &|;<> $HOME"]) {
                let cmd = sh_c(&format!("printf %s {}", quote(p))).unwrap();
                let out = std::process::Command::new(csh).arg("-f").arg("-c").arg(&cmd).output().unwrap();
                assert_eq!(String::from_utf8_lossy(&out.stdout), p, "{csh}: {p:?} {}", String::from_utf8_lossy(&out.stderr));
            }
        }
        assert!(!std::path::Path::new("/tmp/kybl-csh-pwned").exists());
    }

    /// The PATH the server scripts run with keeps absolute folders only.
    #[cfg(unix)]
    #[test]
    fn server_scripts_drop_relative_path_entries() {
        let cmd = sh_c("printf %s \"$PATH\"").unwrap();
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&cmd).env("PATH", ":.:/usr/bin:bin:/bin::").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "/usr/bin:/bin");
        // no absolute entry at all: not an empty PATH (which searches the current folder)
        for none in ["", ".", "bin::."] {
            let out = std::process::Command::new("/bin/sh").arg("-c").arg(&cmd).env("PATH", none).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "/usr/bin:/bin", "{none:?}");
        }
    }

    /// A login shell that isn't POSIX (fish, nushell, csh) still hands its PATH to the /bin/sh
    /// that runs the line (B6-1): Homebrew's tools stay found.
    #[cfg(all(unix, desktop))]
    #[test]
    fn other_login_shells_keep_their_path() {
        assert_eq!(local::path_from_env("motd PATH=/x\nHOME=/h\nPATH=/opt/homebrew/bin:.:bin:/usr/bin\n").as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(local::path_from_env("HOME=/h\n"), None);
        assert_eq!(local::path_from_env("PATH=.:rel\n"), None);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            for sh in ["/bin/zsh", "/bin/tcsh", "/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"].into_iter().filter(|p| std::path::Path::new(p).exists()) {
                let p = local::login_path(sh).await.unwrap_or_else(|| panic!("{sh} gave no PATH"));
                assert!(p.split(':').any(|d| d == "/usr/bin" || d == "/bin"), "{sh}: {p}");
            }
        });
    }

    /// Only a POSIX `$SHELL` runs an action line: csh expands `!#` inside single quotes, and
    /// nushell, PowerShell and the like read the quoting differently.
    #[cfg(all(unix, desktop))]
    #[test]
    fn local_actions_run_only_in_posix_shells() {
        assert_eq!(local::user_shell(Some("/bin/tcsh".into())), "/bin/sh");
        assert_eq!(local::user_shell(Some("/bin/csh".into())), "/bin/sh");
        // an existing program whose name isn't a known shell (stands in for pwsh, nu, xonsh, fish)
        for other in ["/usr/bin/true", "/bin/ls"].into_iter().filter(|p| std::path::Path::new(p).exists()) {
            assert_eq!(local::user_shell(Some(other.into())), "/bin/sh", "{other}");
        }
        if std::path::Path::new("/bin/zsh").exists() {
            assert_eq!(local::user_shell(Some("/bin/zsh".into())), "/bin/zsh");
        }
        if std::path::Path::new("/bin/bash").exists() {
            assert_eq!(local::user_shell(Some("/bin/bash".into())), "/bin/bash");
        }
        assert_eq!(local::user_shell(Some("zsh".into())), "/bin/sh");
        assert_eq!(local::user_shell(None), "/bin/sh");
    }

    /// The script replaces the login shell, so a signal sent to the session reaches it.
    #[cfg(unix)]
    #[test]
    fn server_scripts_replace_the_login_shell() {
        let cmd = sh_c("echo $$").unwrap();
        assert!(cmd.starts_with("exec /bin/sh -c "));
        for sh in ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/tcsh", "/bin/csh"].into_iter().filter(|p| std::path::Path::new(p).exists()) {
            let child = std::process::Command::new(sh).arg("-c").arg(&cmd).stdout(std::process::Stdio::piped()).spawn().unwrap();
            let pid = child.id();
            let out = child.wait_with_output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), pid.to_string(), "{sh}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn nasty_names_stay_one_word_each() {
        for p in NASTY {
            assert_eq!(words(&quote(p)), vec![p.to_string()], "{p:?}");
        }
        // all of them at once, as {paths}
        let items: Vec<Item> = NASTY.iter().map(|p| item(p)).collect();
        let line = expand("{paths}", &items, "/tmp", false);
        assert_eq!(words(&line[0]), NASTY.to_vec());
    }

    #[cfg(unix)]
    #[test]
    fn nothing_in_a_name_runs() {
        let dir = std::env::temp_dir().join(format!("kybl-actions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let evil = format!("{}/$(touch {})`touch {}`;touch {}.jpg", dir.display(), marker.display(), marker.display(), marker.display());
        for line in expand("printf '%s' {path} {name} {stem} {ext} {dir} {paths} >/dev/null", &[item(&evil)], &evil, false) {
            let st = std::process::Command::new("/bin/sh").arg("-c").arg(&line).status().unwrap();
            assert!(st.success());
        }
        assert!(!marker.exists(), "a file name ran as a command");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leading_dashes_get_dot_slash() {
        let it = [item("-rf"), item("/abs/-x.txt")];
        assert_eq!(expand("rm {path}", &it, "/d", false), vec!["rm './-rf'", "rm '/abs/-x.txt'"]);
        assert_eq!(expand("echo {name}", &it, "/d", false), vec!["echo './-rf'", "echo './-x.txt'"]);
        assert_eq!(expand("echo {stem}", &[item("/a/--help.md")], "/d", false), vec!["echo './--help'"]);
        assert_eq!(expand("cd {dir}", &[], "-dir", false), vec!["cd './-dir'"]);
    }

    #[test]
    fn per_item_placeholders_run_once_per_item() {
        let it = [item("/p/photo.final.JPG"), item("/p/sub/"), item("/p/.bashrc")];
        assert_eq!(
            expand("x {name} {stem} {ext}", &it, "/p", false),
            vec!["x 'photo.final.JPG' 'photo.final' 'JPG'", "x 'sub' 'sub' ''", "x '.bashrc' '.bashrc' ''"]
        );
        assert_eq!(expand("sips -Z 2048 {path}", &it[..1], "/p", false), vec!["sips -Z 2048 '/p/photo.final.JPG'"]);
    }

    #[test]
    fn all_items_placeholders_run_once() {
        let it = [item("/p/a.txt"), item("/p/b c.txt")];
        assert_eq!(expand("shasum -a 256 {paths}", &it, "/p", false), vec!["shasum -a 256 '/p/a.txt' '/p/b c.txt'"]);
        assert_eq!(expand("ls {dir}", &it, "/p q", false), vec!["ls '/p q'"]);
        assert_eq!(expand("date", &it, "/p", false), vec!["date"]);
        // {paths} next to a per-item one: every item each time
        assert_eq!(expand("cmp {path} {paths}", &it, "/p", false).len(), 2);
    }

    #[test]
    fn shell_braces_and_unknown_words_are_left_alone() {
        let it = [item("/p/a.txt")];
        assert_eq!(expand("echo ${path} {unknown} {} {path", &it, "/p", false), vec!["echo ${path} {unknown} {} {path"]);
        assert_eq!(expand("awk '{print $1}' {path}", &it, "/p", false), vec!["awk '{print $1}' '/p/a.txt'"]);
        assert_eq!(expand("echo {{path}}", &it, "/p", false), vec!["echo {'/p/a.txt'}"]);
    }

    #[test]
    fn windows_paths_name_too() {
        assert_eq!(name_of(r"C:\Users\me\file.txt", true), "file.txt");
        assert_eq!(name_of("/a/b/", true), "b");
        assert_eq!(name_of("/a/b/", false), "b");
    }

    /// On Unix and servers a backslash is part of the name (B6-1): `{name}` of `/data/a\b.txt`
    /// is `a\b.txt`, never `b.txt` (which could be another file in the same folder).
    #[test]
    fn backslashes_stay_in_unix_names() {
        assert_eq!(name_of(r"/data/a\b.txt", false), r"a\b.txt");
        assert_eq!(name_of(r"/data/x\", false), r"x\");
        let it = [item(r"/data/a\b.txt")];
        assert_eq!(expand("echo {name} {stem} {ext}", &it, "/data", false), vec![r"echo 'a'\\'b.txt' 'a'\\'b' 'txt'"]);
    }

    #[test]
    fn utf8_split_across_chunks_waits_for_the_rest() {
        let s = "ž".as_bytes();
        let (t, keep) = utf8_prefix(&[b'a', s[0]]);
        assert_eq!((t.as_str(), keep.as_slice()), ("a", &s[..1]));
        let (t, keep) = utf8_prefix(&[s[0], s[1]]);
        assert_eq!((t.as_str(), keep.len()), ("ž", 0));
        // invalid bytes don't hold anything back
        let (t, keep) = utf8_prefix(&[0xff, b'x']);
        assert_eq!((t.as_str(), keep.len()), ("\u{fffd}x", 0));
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn local_runs_stream_and_stop() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let cancel = AtomicBool::new(false);
            let mut out = Vec::new();
            let (code, stopped) = local::run("printf hi; printf oops >&2; exit 3", "/", &cancel, |e, b| out.push((e, b.to_vec()))).await.unwrap();
            assert_eq!((code, stopped), (Some(3), false));
            assert!(out.contains(&(false, b"hi".to_vec())) && out.contains(&(true, b"oops".to_vec())));

            let cancel = Arc::new(AtomicBool::new(false));
            let c2 = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                c2.store(true, Ordering::Relaxed);
            });
            let t = std::time::Instant::now();
            let (code, stopped) = local::run("sleep 30; echo late", "/", &cancel, |_, _| {}).await.unwrap();
            assert!(stopped && code.is_none() && t.elapsed() < std::time::Duration::from_secs(5));

            // something left running in the background holds the pipes: the run still ends with
            // the shell, output before that included
            let cancel = AtomicBool::new(false);
            let t = std::time::Instant::now();
            let mut out = Vec::new();
            let (code, stopped) = local::run("printf before; sleep 20 & exit 4", "/", &cancel, |_, b| out.extend_from_slice(b)).await.unwrap();
            assert_eq!((code, stopped), (Some(4), false));
            assert_eq!(out, b"before");
            assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
        });
    }

    /// A program the action leaves running keeps working after the run has ended: its later
    /// output goes nowhere instead of killing it (SIGPIPE).
    #[cfg(all(unix, desktop))]
    #[test]
    fn background_programs_outlive_the_run() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let flag = std::env::temp_dir().join(format!("kybl-bg-{}", uuid::Uuid::new_v4().simple()));
        rt.block_on(async {
            let cancel = AtomicBool::new(false);
            let line = format!("(sleep 1; echo late; echo late >&2; touch {}) & exit 0", quote(&flag.to_string_lossy()));
            let (code, stopped) = local::run(&line, "/", &cancel, |_, _| {}).await.unwrap();
            assert_eq!((code, stopped), (Some(0), false));
            assert!(!flag.exists());
            for _ in 0..40 {
                if flag.exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });
        assert!(flag.exists(), "the background program died on its first write");
        std::fs::remove_file(flag).ok();
    }
}
