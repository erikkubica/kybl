/**
 * How a program, script or installer can run, by what it is and where it is: a Windows program on
 * this PC runs (as administrator too, through Windows' own prompt) or runs in a terminal; a script
 * or Linux package on this computer or on a server with a shell runs in a terminal in its folder,
 * as administrator with sudo. A file for another system gets nothing here (Open still asks first,
 * runnable.ts). Pure: the file menu (useEntryActions) turns these into its Run items.
 */
import type { Os } from "../../core/osNames.ts";
import { quoteAs, shellQuote, type Quoting } from "../../terminal/lib/quote.ts";

/** Where the file is: this computer (running `os`), or a server whose shell is a Unix one. */
export type RunWhere = {
  local: boolean;
  os: Os;
  /** a terminal can open in the file's folder (this computer, an SFTP server) */
  terminal: boolean;
  /** this computer's terminal shell on Windows (`terminalShell()`: "", pwsh, powershell, cmd, wsl, gitbash) */
  winShell?: string;
};

export type RunChoice =
  /** the system runs it as it does on a double-click (its default action) */
  | { label: string; how: "open" }
  /** Windows' administrator prompt (`run_elevated`) */
  | { label: string; how: "elevate" }
  /** typed into a new terminal in the file's folder, once its shell is up (null: this shell can't take the name) */
  | { label: string; how: "terminal"; line: (q: Quoting) => string | null };

const ext = (name: string) => {
  const n = name.replace(/[\s.]+$/, "").toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(dot + 1) : "";
};

/** Unix scripts by the program that reads them */
const READERS: Record<string, string> = {
  sh: "bash",
  bash: "bash",
  command: "bash",
  zsh: "zsh",
  ksh: "ksh",
  csh: "csh",
  fish: "fish",
  py: "python3",
  pl: "perl",
  rb: "ruby",
  php: "php",
};
/** self-running files: made executable, then run */
const BINARIES = new Set(["run", "bin", "appimage"]);
const WIN_PROGRAMS = new Set(["exe", "com", "bat", "cmd"]);

/** `./name`, quoted for a Unix shell (a name starting with "-" can't pass for an option) */
const here = (name: string) => shellQuote(`./${name}`);
const posixy = (q: Quoting) => q === "posix" || q === "wsl";

/** The ways file `name` can run where it is, in menu order; none for files that don't run there. */
export function runChoices(name: string, w: RunWhere): RunChoice[] {
  const x = ext(name);
  // on Windows, this PC
  if (w.local && w.os === "win") {
    if (WIN_PROGRAMS.has(x))
      return [
        { label: "Run", how: "open" },
        { label: "Run as administrator", how: "elevate" },
        ...(w.terminal
          ? [
              {
                label: "Run in terminal",
                how: "terminal" as const,
                line: (q: Quoting) => (q === "powershell" ? withAmp(quoteAs(q, `.\\${name}`)) : q === "cmd" ? quoteAs(q, name) : here(name)),
              },
            ]
          : []),
      ];
    if (x === "msi")
      return [
        { label: "Install", how: "open" },
        { label: "Install as administrator", how: "elevate" },
      ];
    if (x === "ps1")
      return [
        ...(w.terminal
          ? [
              {
                label: "Run in terminal",
                how: "terminal" as const,
                line: (q: Quoting) => {
                  if (q === "powershell") return withAmp(quoteAs(q, `.\\${name}`));
                  const f = q === "cmd" ? quoteAs(q, name) : shellQuote(name);
                  return f == null ? null : `${q === "cmd" ? "powershell" : "powershell.exe"} -NoLogo -File ${f}`;
                },
              },
            ]
          : []),
        { label: "Run as administrator", how: "elevate" },
      ];
    // a Unix script, where the terminal's shell is WSL or Git Bash
    if (!READERS[x] || !w.terminal || !["wsl", "gitbash"].includes(w.winShell ?? "")) return [];
    return unixChoices(x, name, false);
  }
  // this Mac or Linux computer, or a server (its shell is a Unix one)
  if (!w.terminal) return [];
  if (w.local && w.os === "mac" && (x === "appimage" || x === "deb" || x === "rpm")) return [];
  return unixChoices(x, name, true);
}

function withAmp(q: string | null) {
  return q == null ? null : `& ${q}`;
}

function unixChoices(x: string, name: string, packages: boolean): RunChoice[] {
  const reader = READERS[x];
  if (reader) {
    const line = (sudo: boolean) => (q: Quoting) => {
      const f = posixy(q) ? here(name) : null;
      return f == null ? null : `${sudo ? "sudo " : ""}${reader} ${f}`;
    };
    return [
      { label: "Run in terminal", how: "terminal", line: line(false) },
      { label: "Run as administrator", how: "terminal", line: line(true) },
    ];
  }
  if (BINARIES.has(x)) {
    const line = (sudo: boolean) => (q: Quoting) => {
      const f = posixy(q) ? here(name) : null;
      return f == null ? null : `chmod +x ${f} && ${sudo ? "sudo " : ""}${f}`;
    };
    return [
      { label: "Run in terminal", how: "terminal", line: line(false) },
      { label: "Run as administrator", how: "terminal", line: line(true) },
    ];
  }
  if (packages && (x === "deb" || x === "rpm")) {
    // the system's own installer, which also fetches what the package needs
    const tool = x === "deb" ? "apt" : '"$(command -v dnf || command -v yum || command -v zypper)"';
    return [
      {
        label: "Install in terminal",
        how: "terminal",
        line: (q) => {
          const f = posixy(q) ? here(name) : null;
          return f == null ? null : `sudo ${tool} install ${f}`;
        },
      },
    ];
  }
  return [];
}
