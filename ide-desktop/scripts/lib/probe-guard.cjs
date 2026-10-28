/*
 * Main-process crash guard for the Electron scripts in this folder.
 *
 * Why this file exists: Electron installs its own `uncaughtException` handler,
 * and that handler calls `dialog.showErrorBox` - a modal box on the desktop of
 * whoever launched the probe, together with the Windows error beep. Nobody is
 * sitting in front of a smoke or audit run to dismiss it, so a single thrown
 * assertion leaves a dialog parked on screen until the process is killed by
 * hand. That is not hypothetical: a throwaway a11y probe threw in the main
 * process and its error box sat on top of the app until someone noticed.
 *
 * These two handlers replace that with a stack trace on stderr and exit code 1.
 * CI gets the same signal it got before, minus the window and the noise.
 *
 * Usage - one line, first statement after the header comment of the script:
 *
 *   require('./lib/probe-guard.cjs');
 *
 * It has to run before anything that can throw, which is why it is a bare
 * require with a side effect rather than an exported function nobody calls.
 */
process.on('uncaughtException', (err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err && err.stack ? err.stack : err);
  process.exit(1);
});
