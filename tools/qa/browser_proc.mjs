// A throwaway headless browser and its profile folder, stopped and deleted however the run ends.
// Shared by tests/browser/run_shaders.mjs (the shader check) and tools/qa/lib.mjs (the QA drivers).
//
// Why each piece is here:
//  - the browser runs in its own process group (spawned detached), so stopping it stops every helper it started
//    (GPU, renderer, crashpad). Killing only the main process left helpers that wrote into the profile after it was
//    deleted, and the folder came back (ss-shaders-o9iXU1, and the same in tools/qa/lib.mjs's ssqa-*).
//  - the profile is deleted only after the group is gone, with retries.
//  - Ctrl-C, SIGTERM and process.exit() skip a `finally`: guardExit() stops the group and deletes the profile first
//    (a SIGTERM'd run left ss-shaders-WrZGjD and its detached Chrome running).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const GROUP = process.platform !== "win32";

/** spawn() in its own process group (not on Windows). */
export function spawnBrowser(exe, args, opts = {}) {
  return spawn(exe, args, { ...opts, detached: GROUP });
}

/** SIGKILL the browser and every process in its group. Safe to call twice or on an exited browser. */
export function killGroup(child) {
  if (!child?.pid) return;
  try { process.kill(GROUP ? -child.pid : child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

export function removeProfile(dir) {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Resolves when the browser's main process has closed, or after ms. */
export function closed(child, ms = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => { const t = setTimeout(ok, ms); child.once("close", () => { clearTimeout(t); ok(); }); });
}

/** Stop the whole group, wait for it to close (5 s at most), delete the profile; once more 300 ms later in case a
 *  killed helper was still closing a file. */
export async function stopBrowser(child, dir) {
  killGroup(child);
  await closed(child);
  removeProfile(dir);
  await sleep(300);
  removeProfile(dir);
}

/** The same without the event loop (for signal and exit handlers). */
export function stopBrowserSync(child, dir) {
  killGroup(child);
  sleepSync(300);
  removeProfile(dir);
  sleepSync(200);
  removeProfile(dir);
}

/**
 * While a browser runs: on SIGINT / SIGTERM / SIGHUP or process exit, stop its group and delete its profile.
 * getChild() returns the current child (it may not be spawned yet). Returns release(), to call when the run's own
 * cleanup takes over. After a signal the process still ends the way it would have (the signal is raised again
 * when no other handler is listening).
 */
export function guardExit(getChild, dir) {
  const sigs = GROUP ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM"];
  const onSig = {};
  const onExit = () => stopBrowserSync(getChild(), dir);
  const release = () => { for (const s of sigs) process.removeListener(s, onSig[s]); process.removeListener("exit", onExit); };
  for (const s of sigs) {
    onSig[s] = () => {
      release();
      stopBrowserSync(getChild(), dir);
      if (process.listenerCount(s) === 0) process.kill(process.pid, s);
    };
    process.on(s, onSig[s]);
  }
  process.on("exit", onExit);
  return release;
}
