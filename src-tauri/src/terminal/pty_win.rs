//! A pseudo-terminal on this computer (Windows): a ConPTY pseudo console, the shell started on it
//! with `CreateProcessW`, as Windows Terminal starts one. The same face as `pty.rs` (Unix), so the
//! terminal's life in `mod.rs` is one piece of code for both.
//!
//! The reader and writer are threads on plain anonymous pipes (`std::io::pipe`). The pseudo
//! console is closed once the shell ends (or the pane goes): that flushes what it still holds and
//! breaks the output pipe, so the reader ends as on Unix when nobody has the terminal any more.
//!
//! The shells on offer ([`shells`]): PowerShell 7 or Windows PowerShell, Command Prompt, WSL and
//! Git Bash, whichever are installed.

use std::{
    ffi::{OsStr, OsString},
    io::{self, PipeReader, Read, Write},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc, Arc, Mutex,
    },
    time::Duration,
};

use tokio::sync::{mpsc, oneshot};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
    System::{
        Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON},
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
            WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
        },
    },
};

/// How long a program asked to close has to go before it is ended.
const KILL_AFTER: Duration = Duration::from_secs(3);

/// The pseudo console, closed once: when the shell ends, the pane goes, or reading stops.
struct Console(Mutex<Option<HPCON>>);

impl Console {
    /// Closes it on a thread of its own: closing waits for its output to be read.
    fn close(self: &Arc<Self>) {
        let Some(hpc) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        let _ = std::thread::Builder::new().name("kybl-pty-close".into()).spawn(move || unsafe { ClosePseudoConsole(hpc) });
    }
    /// Closes it here, returning once it has handed over its last output (a thread that may block).
    fn close_now(&self) {
        let Some(hpc) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        unsafe { ClosePseudoConsole(hpc) };
    }
}

/// A program running on a pseudo console.
pub struct Pty {
    pid: u32,
    process: Arc<OwnedHandle>,
    console: Arc<Console>,
    input: Option<std_mpsc::Sender<Vec<u8>>>,
    exited: Arc<AtomicBool>,
}

/// What a started program reports: its output (closed once the terminal has nothing more), and
/// its exit code once it ends.
pub struct PtyEvents {
    pub output: mpsc::Receiver<Vec<u8>>,
    pub exit: oneshot::Receiver<Option<i32>>,
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD { X: cols.clamp(1, i16::MAX as u16) as i16, Y: rows.clamp(1, i16::MAX as u16) as i16 }
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// One argument quoted as `CommandLineToArgvW` (and the C runtime) read it back.
fn quote_arg(arg: &OsStr, out: &mut Vec<u16>) {
    let a: Vec<u16> = arg.encode_wide().collect();
    let plain = !a.is_empty() && !a.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16 || c == b'"' as u16);
    if plain {
        out.extend(a);
        return;
    }
    out.push(b'"' as u16);
    let mut slashes = 0;
    for &c in &a {
        if c == b'\\' as u16 {
            slashes += 1;
        } else {
            if c == b'"' as u16 {
                // the backslashes before a quote double, and the quote is escaped
                out.extend(std::iter::repeat_n(b'\\' as u16, slashes + 1));
            }
            slashes = 0;
        }
        out.push(c);
    }
    // backslashes before the closing quote double
    out.extend(std::iter::repeat_n(b'\\' as u16, slashes));
    out.push(b'"' as u16);
}

/// The app's environment with `env` on top, as a Unicode environment block (sorted, as Windows wants it).
fn env_block(env: &[(&str, String)]) -> Vec<u16> {
    let mut vars: Vec<(OsString, OsString)> = std::env::vars_os().filter(|(k, _)| !env.iter().any(|(e, _)| OsStr::new(e).eq_ignore_ascii_case(k))).collect();
    vars.extend(env.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))));
    vars.sort_by_key(|(k, _)| k.to_string_lossy().to_uppercase());
    let mut out = Vec::new();
    for (k, v) in vars {
        out.extend(k.encode_wide());
        out.push(b'=' as u16);
        out.extend(v.encode_wide());
        out.push(0);
    }
    out.push(0);
    out
}

impl Pty {
    /// Starts `program` with `args` in `cwd` on a new pseudo console of `cols` × `rows`, with `env`
    /// set on top of the app's own environment.
    pub fn spawn(program: &Path, args: &[&OsStr], cwd: &Path, env: &[(&str, String)], cols: u16, rows: u16, queue: usize) -> io::Result<(Pty, PtyEvents)> {
        // the console reads what we write to `in_w` from `in_r`, and writes the screen to `out_w`
        let (in_r, in_w) = io::pipe()?;
        let (out_r, out_w) = io::pipe()?;
        let mut hpc: HPCON = 0;
        let hr = unsafe { CreatePseudoConsole(coord(cols, rows), in_r.as_raw_handle() as HANDLE, out_w.as_raw_handle() as HANDLE, 0, &mut hpc) };
        if hr < 0 {
            // an HRESULT, not a Win32 error code
            return Err(io::Error::other(format!("The pseudo console didn't start (0x{:08x}).", hr as u32)));
        }
        let console = Arc::new(Console(Mutex::new(Some(hpc))));
        // the console has its own copies of these now
        drop(in_r);
        drop(out_w);

        let process = match start(hpc, program, args, cwd, env) {
            Ok(p) => p,
            Err(e) => {
                console.close();
                return Err(e);
            }
        };
        let pid = process.1;
        let process = Arc::new(process.0);

        let (out_tx, out_rx) = mpsc::channel(queue);
        std::thread::Builder::new().name("kybl-pty-read".into()).spawn(move || read_loop(out_r, out_tx))?;

        let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
        let mut writer = in_w;
        std::thread::Builder::new().name("kybl-pty-write".into()).spawn(move || {
            for b in in_rx {
                if writer.write_all(&b).is_err() {
                    break;
                }
            }
        })?;

        let exited = Arc::new(AtomicBool::new(false));
        let (exit_tx, exit_rx) = oneshot::channel();
        let (done, proc2, con2) = (exited.clone(), process.clone(), console.clone());
        std::thread::Builder::new().name("kybl-pty-wait".into()).spawn(move || {
            let h = proc2.as_raw_handle() as HANDLE;
            let mut code = None;
            if unsafe { WaitForSingleObject(h, INFINITE) } == WAIT_OBJECT_0 {
                let mut c = 0u32;
                if unsafe { GetExitCodeProcess(h, &mut c) } != 0 {
                    code = Some(c as i32);
                }
            }
            done.store(true, Ordering::SeqCst);
            // the shell is gone: the console hands over what it still shows and its pipe breaks,
            // and only then is the exit told, so the last lines aren't cut off
            con2.close_now();
            let _ = exit_tx.send(code);
        })?;

        Ok((Pty { pid, process, console, input: Some(in_tx), exited }, PtyEvents { output: out_rx, exit: exit_rx }))
    }

    /// Types `bytes` into the terminal.
    pub fn write(&self, bytes: Vec<u8>) {
        if let Some(tx) = &self.input {
            let _ = tx.send(bytes);
        }
    }

    /// The terminal's new size.
    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(hpc) = *self.console.0.lock().unwrap_or_else(|e| e.into_inner()) {
            unsafe {
                ResizePseudoConsole(hpc, coord(cols, rows));
            }
        }
    }

    /// Whether the shell runs a program: it has a child process (other than the console's own helpers).
    pub fn busy(&self) -> bool {
        if self.exited.load(Ordering::SeqCst) {
            return false;
        }
        has_child(self.pid)
    }

    /// Stops reading: what the terminal still holds is left behind.
    pub fn stop_reading(&mut self) {
        self.console.close();
    }
}

/// Ending a terminal: closing the console asks its programs to close, as closing a console
/// window does; the shell is ended if it's still there a moment later.
impl Drop for Pty {
    fn drop(&mut self) {
        self.input = None;
        self.console.close();
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        let (process, exited) = (self.process.clone(), self.exited.clone());
        let _ = std::thread::Builder::new().name("kybl-pty-kill".into()).spawn(move || {
            std::thread::sleep(KILL_AFTER);
            if !exited.load(Ordering::SeqCst) {
                unsafe {
                    TerminateProcess(process.as_raw_handle() as HANDLE, 1);
                }
            }
        });
    }
}

/// Starts the program attached to pseudo console `hpc`: its process handle and id.
fn start(hpc: HPCON, program: &Path, args: &[&OsStr], cwd: &Path, env: &[(&str, String)]) -> io::Result<(OwnedHandle, u32)> {
    let mut size = 0usize;
    unsafe {
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
    }
    // (usize-aligned room for the list)
    let mut room = vec![0usize; size.div_ceil(std::mem::size_of::<usize>()).max(1)];
    let list = room.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    struct List(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for List {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.0) }
        }
    }
    let _list = List(list);
    if unsafe { UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize, hpc as *const core::ffi::c_void, std::mem::size_of::<HPCON>(), std::ptr::null_mut(), std::ptr::null()) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = list;
    // no handles of ours: the console is its standard input and output
    si.StartupInfo.hStdInput = std::ptr::null_mut();
    si.StartupInfo.hStdOutput = std::ptr::null_mut();
    si.StartupInfo.hStdError = std::ptr::null_mut();

    let mut cmdline = Vec::new();
    quote_arg(program.as_os_str(), &mut cmdline);
    for a in args {
        cmdline.push(b' ' as u16);
        quote_arg(a, &mut cmdline);
    }
    cmdline.push(0);
    let app = wide(program.as_os_str());
    let dir = wide(cwd.as_os_str());
    let block = env_block(env);
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            app.as_ptr(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            block.as_ptr() as *const core::ffi::c_void,
            dir.as_ptr(),
            &si.StartupInfo,
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        drop(OwnedHandle::from_raw_handle(pi.hThread as _));
        Ok((OwnedHandle::from_raw_handle(pi.hProcess as _), pi.dwProcessId))
    }
}

/// Reads the console's output until its pipe breaks (the console closed) or the queue's receiver is gone.
fn read_loop(mut from: PipeReader, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if tx.blocking_send(buf[..n].to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

/// Whether process `pid` has a child that isn't one of the console's helpers.
fn has_child(pid: u32) -> bool {
    const HELPERS: [&str; 3] = ["conhost.exe", "openconsole.exe", "wslhost.exe"];
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        // when in doubt, busy: closing then asks first
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return true;
        }
        let _snap = OwnedHandle::from_raw_handle(snap as _);
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snap, &mut e) != 0;
        while more {
            if e.th32ParentProcessID == pid && e.th32ProcessID != pid {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = OsString::from_wide(&e.szExeFile[..len]).to_string_lossy().to_lowercase();
                if !HELPERS.contains(&name.as_str()) {
                    return true;
                }
            }
            more = Process32NextW(snap, &mut e) != 0;
        }
    }
    false
}

// ------------------------------------------------------------ the shells on offer

/// A shell a terminal can run: `id` is what the page saves, `quoting` how it wants paths typed.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    pub program: PathBuf,
    #[serde(skip)]
    pub args: Vec<&'static str>,
    pub quoting: &'static str,
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// `exe` in a folder on PATH.
fn on_path(exe: &str) -> Option<PathBuf> {
    // only absolute folders: a relative one would find a program in the app's working folder
    std::env::split_paths(&std::env::var_os("PATH")?).filter(|d| d.is_absolute()).map(|d| d.join(exe)).find(|p| p.is_file())
}

/// The shells installed here, the default first: PowerShell 7, else Windows PowerShell.
pub fn shells() -> Vec<ShellOption> {
    let sys = env_dir("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32");
    let program_files = env_dir("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let mut out = Vec::new();
    let pwsh = on_path("pwsh.exe").or_else(|| Some(program_files.join(r"PowerShell\7\pwsh.exe")).filter(|p| p.is_file()));
    if let Some(p) = pwsh {
        out.push(ShellOption { id: "pwsh", name: "PowerShell", program: p, args: vec!["-NoLogo"], quoting: "powershell" });
    }
    let ps = sys.join(r"WindowsPowerShell\v1.0\powershell.exe");
    if ps.is_file() {
        out.push(ShellOption { id: "powershell", name: "Windows PowerShell", program: ps, args: vec!["-NoLogo"], quoting: "powershell" });
    }
    let cmd = env_dir("ComSpec").filter(|p| p.is_file()).unwrap_or_else(|| sys.join("cmd.exe"));
    if cmd.is_file() {
        out.push(ShellOption { id: "cmd", name: "Command Prompt", program: cmd, args: vec![], quoting: "cmd" });
    }
    let wsl = sys.join("wsl.exe");
    if wsl.is_file() {
        out.push(ShellOption { id: "wsl", name: "WSL", program: wsl, args: vec![], quoting: "wsl" });
    }
    let git_bash = [Some(program_files.join(r"Git\bin\bash.exe")), env_dir("LOCALAPPDATA").map(|d| d.join(r"Programs\Git\bin\bash.exe"))].into_iter().flatten().find(|p| p.is_file());
    if let Some(p) = git_bash {
        out.push(ShellOption { id: "gitbash", name: "Git Bash", program: p, args: vec!["--login", "-i"], quoting: "posix" });
    }
    out
}

/// The shell with id `want`, else the default one.
pub fn pick_shell(want: Option<&str>) -> Option<ShellOption> {
    let all = shells();
    want.and_then(|w| all.iter().find(|s| s.id == w).cloned()).or_else(|| all.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(a: &str) -> String {
        let mut out = Vec::new();
        quote_arg(OsStr::new(a), &mut out);
        String::from_utf16(&out).unwrap()
    }

    #[test]
    fn arguments_are_quoted_as_windows_reads_them_back() {
        assert_eq!(q("-NoLogo"), "-NoLogo");
        assert_eq!(q(r"C:\Program Files\Git\bin\bash.exe"), r#""C:\Program Files\Git\bin\bash.exe""#);
        assert_eq!(q(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(q(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(q(""), r#""""#);
    }
}
