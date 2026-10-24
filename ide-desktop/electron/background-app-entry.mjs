import electron from 'electron';

try {
  const runner = await import('./background-app-runner.cjs');
  await runner.default.start();
} catch (error) {
  const timeout = setTimeout(() => electron.app.exit(1), 250);
  timeout.unref();
  if (process.connected) process.send({ id: 'ready', error: error instanceof Error ? error.message : String(error) }, () => electron.app.exit(1));
  else electron.app.exit(1);
}
