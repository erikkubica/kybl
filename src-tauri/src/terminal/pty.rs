//! A pseudo-terminal on this computer (Unix): `openpty`, and the program started on its other end
//! as the leader of a session of its own with the terminal as its controlling terminal, as
//! Terminal.app starts a shell. Plain libc (already in the tree for the local disk): no crate.
//!
//! The reader is a thread blocked in `poll` on the terminal and a wake-up pipe, so an idle
//! terminal costs nothing, and stopping it never closes a descriptor another thread is reading.
//! Writing goes through a thread of its own too: a program that doesn't read its input must not
//! hold up the app.

use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::process::CommandExt,
    },
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc, Arc,
    },
    time::Duration,
};

use tokio::sync::{mpsc, oneshot};

/// How long a hung-up program has to go before it is killed.
const KILL_AFTER: Duration = Duration::from_secs(3);

/// A program running on a pseudo-terminal.
pub struct Pty {
    pid: libc::pid_t,
    /// the terminal's side the app writes to and sizes (a duplicate of what the reader reads)
    master: Arc<OwnedFd>,
    input: Option<std_mpsc::Sender<Vec<u8>>>,
    /// wakes the reader to stop
    wake: Option<OwnedFd>,
    exited: Arc<AtomicBool>,
}

/// What a started program reports: its output (closed once the terminal has nothing more), and
/// its exit code once it ends (None: ended by a signal).
pub struct PtyEvents {
    pub output: mpsc::Receiver<Vec<u8>>,
    pub exit: oneshot::Receiver<Option<i32>>,
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r == -1 { Err(io::Error::last_os_error()) } else { Ok(r) }
}

fn cloexec(fd: RawFd) -> io::Result<()> {
    unsafe {
        let flags = cvt(libc::fcntl(fd, libc::F_GETFD))?;
        cvt(libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC))?;
    }
    Ok(())
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 }
}

impl Pty {
    /// Starts `program` with `args` in `cwd` on a new terminal of `cols` × `rows`, with `env` set
    /// on top of the app's own environment.
    pub fn spawn(program: &Path, args: &[&OsStr], cwd: &Path, env: &[(&str, String)], cols: u16, rows: u16, queue: usize) -> io::Result<(Pty, PtyEvents)> {
        let (mut m, mut s): (libc::c_int, libc::c_int) = (-1, -1);
        let mut ws = winsize(cols, rows);
        cvt(unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) })?;
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
        // neither leaks into the program (it gets the terminal as 0, 1 and 2) or later ones
        cloexec(master.as_raw_fd())?;
        cloexec(slave.as_raw_fd())?;

        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        for (k, v) in env {
            cmd.env(k, v);
        }
        // between fork and exec: only async-signal-safe calls (std resets the signal mask)
        unsafe {
            cmd.pre_exec(|| {
                cvt(libc::setsid())?;
                cvt(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
                Ok(())
            });
        }
        let mut child = cmd.spawn()?;
        // (the terminal's other end now lives in the program only: `cmd` dropped its copies)
        drop(cmd);
        let pid = child.id() as libc::pid_t;

        let (wake_r, wake_w) = {
            let mut fds = [0 as libc::c_int; 2];
            cvt(unsafe { libc::pipe(fds.as_mut_ptr()) })?;
            let p = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
            cloexec(fds[0])?;
            cloexec(fds[1])?;
            p
        };

        let (out_tx, out_rx) = mpsc::channel(queue);
        let reader = File::from(master.try_clone()?);
        std::thread::Builder::new().name("kybl-pty-read".into()).spawn(move || read_loop(reader, wake_r, out_tx))?;

        let master = Arc::new(master);
        let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
        let mut writer = File::from(master.try_clone()?);
        std::thread::Builder::new().name("kybl-pty-write".into()).spawn(move || {
            for b in in_rx {
                if writer.write_all(&b).is_err() {
                    break;
                }
            }
        })?;

        let exited = Arc::new(AtomicBool::new(false));
        let (exit_tx, exit_rx) = oneshot::channel();
        let done = exited.clone();
        std::thread::Builder::new().name("kybl-pty-wait".into()).spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            done.store(true, Ordering::SeqCst);
            let _ = exit_tx.send(code);
        })?;

        Ok((Pty { pid, master, input: Some(in_tx), wake: Some(wake_w), exited }, PtyEvents { output: out_rx, exit: exit_rx }))
    }

    /// Types `bytes` into the terminal.
    pub fn write(&self, bytes: Vec<u8>) {
        if let Some(tx) = &self.input {
            let _ = tx.send(bytes);
        }
    }

    /// The terminal's new size (the program gets SIGWINCH from the system).
    pub fn resize(&self, cols: u16, rows: u16) {
        let ws = winsize(cols, rows);
        unsafe {
            libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws);
        }
    }

    /// Whether a program other than the shell runs in the foreground: the terminal's foreground
    /// process group isn't the shell's own (the shell leads its session, so its group is its pid).
    pub fn busy(&self) -> bool {
        let fg = unsafe { libc::tcgetpgrp(self.master.as_raw_fd()) };
        fg > 0 && fg != self.pid
    }

    /// Stops reading: what the terminal still holds is left behind.
    pub fn stop_reading(&mut self) {
        if let Some(w) = self.wake.take() {
            let _ = File::from(w).write_all(&[1]);
        }
    }
}

/// Ending a terminal: the program and its jobs get a hang-up, as when a terminal window closes,
/// and are killed if they're still there a moment later.
impl Drop for Pty {
    fn drop(&mut self) {
        self.input = None;
        self.stop_reading();
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        let (pid, exited) = (self.pid, self.exited.clone());
        unsafe {
            // the shell's process group; an interactive shell passes the hang-up on to its jobs
            libc::kill(-pid, libc::SIGHUP);
            libc::kill(pid, libc::SIGHUP);
        }
        let _ = std::thread::Builder::new().name("kybl-pty-kill".into()).spawn(move || {
            std::thread::sleep(KILL_AFTER);
            if !exited.load(Ordering::SeqCst) {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        });
    }
}

/// Reads the terminal until it has nothing more (every program on it ended), the queue's
/// receiver is gone, or `wake` says stop. Blocks in `poll` meanwhile: no timer, no spinning.
fn read_loop(mut master: File, wake: OwnedFd, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = vec![0u8; 16 * 1024];
    let mut fds = [
        libc::pollfd { fd: master.as_raw_fd(), events: libc::POLLIN, revents: 0 },
        libc::pollfd { fd: wake.as_raw_fd(), events: libc::POLLIN, revents: 0 },
    ];
    loop {
        fds[0].revents = 0;
        fds[1].revents = 0;
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        if fds[1].revents != 0 {
            return;
        }
        if fds[0].revents == 0 {
            continue;
        }
        match master.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                if tx.blocking_send(buf[..n].to_vec()).is_err() {
                    return;
                }
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) => continue,
            // EIO: nobody has the terminal open any more
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(program: &str, args: &[&str]) -> (String, Option<i32>) {
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        let (pty, mut ev) = Pty::spawn(Path::new(program), &args, Path::new("/"), &[("TERM", "xterm-256color".into())], 80, 24, 8).unwrap();
        let mut out = Vec::new();
        let read = async {
            while let Some(c) = ev.output.recv().await {
                out.extend(c);
            }
        };
        tokio::time::timeout(Duration::from_secs(10), read).await.expect("the terminal never closed");
        let code = tokio::time::timeout(Duration::from_secs(10), ev.exit).await.unwrap().unwrap();
        drop(pty);
        (String::from_utf8_lossy(&out).into_owned(), code)
    }

    #[tokio::test]
    async fn runs_a_program_on_a_terminal_and_reads_its_output() {
        let (out, code) = run("/bin/sh", &["-c", "echo hi"]).await;
        assert_eq!(out.trim(), "hi");
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn the_program_sees_a_terminal_of_the_given_size_in_its_folder() {
        // a controlling terminal (stty reads it), the size, and the working folder
        let (out, code) = run("/bin/sh", &["-c", "test -t 0 && stty size && pwd; exit 3"]).await;
        let lines: Vec<&str> = out.lines().map(str::trim).collect();
        assert_eq!(lines, vec!["24 80", "/"]);
        assert_eq!(code, Some(3));
    }

    #[tokio::test]
    async fn a_program_in_the_foreground_makes_the_shell_busy() {
        let args: Vec<&OsStr> = ["-i"].iter().map(OsStr::new).collect();
        let (pty, mut ev) = Pty::spawn(Path::new("/bin/sh"), &args, Path::new("/"), &[("PS1", "$ ".into()), ("ENV", "/dev/null".into())], 80, 24, 64).unwrap();
        // drain the output meanwhile, so nothing blocks on a full queue
        tokio::spawn(async move { while ev.output.recv().await.is_some() {} });
        let wait_for = |want: bool| {
            let pty = &pty;
            async move {
                for _ in 0..100 {
                    if pty.busy() == want {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                false
            }
        };
        assert!(wait_for(false).await, "an interactive shell at rest isn't busy");
        pty.write(b"sleep 5\r".to_vec());
        assert!(wait_for(true).await, "a program in the foreground makes it busy");
        drop(pty);
    }

    #[tokio::test]
    async fn input_reaches_the_program_and_closing_ends_it() {
        let args: Vec<&OsStr> = ["-c", "read x; echo got:$x; sleep 30"].iter().map(OsStr::new).collect();
        let (pty, mut ev) = Pty::spawn(Path::new("/bin/sh"), &args, Path::new("/"), &[], 80, 24, 8).unwrap();
        pty.write(b"ping\r".to_vec());
        let mut out = String::new();
        let read = async {
            while !out.contains("got:ping") {
                let Some(c) = ev.output.recv().await else { break };
                out.push_str(&String::from_utf8_lossy(&c));
            }
        };
        tokio::time::timeout(Duration::from_secs(10), read).await.unwrap();
        assert!(out.contains("got:ping"), "{out}");
        // closing the pane: the sleeping shell gets a hang-up and goes
        drop(pty);
        let code = tokio::time::timeout(Duration::from_secs(10), ev.exit).await.unwrap().unwrap();
        assert_eq!(code, None, "ended by the hang-up signal");
    }
}
