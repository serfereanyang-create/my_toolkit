/**
 * Which settings changes require tearing down the live CLI child.
 *
 * The child is spawned with its provider, model, base URL, approval mode and
 * automation flags as argv. `settings.set` used to invalidate only on the
 * approval/auto-review/computer-execution changes, so after the user switched
 * suppliers in 设置 → 模型 the running child kept answering with the previous
 * model until the app restarted — the new config was on disk, the old one was
 * in argv.
 *
 * Kept separate from ipc.cjs so it can be tested without Electron.
 */
function settingsNeedAgentRestart(previous, next) {
  if (!previous || !next) return false;
  if (previous.approval !== next.approval) return true;
  if (previous.activeProviderId !== next.activeProviderId) return true;
  const before = previous.preferences ?? {};
  const after = next.preferences ?? {};
  if (before.autoReview !== after.autoReview) return true;
  if ((before.requestTimeoutMs ?? 300_000) !== (after.requestTimeoutMs ?? 300_000)) return true;
  if (before.computerExecutionMode !== after.computerExecutionMode) return true;
  // Every computer-control preference is argv on the child, so flipping it in
  // Settings did nothing to the session already open: the toggles looked live
  // while the running CLI still had the old flags (and, for execution mode,
  // still had every computer_* tool unregistered).
  if (before.computerAnyApp !== after.computerAnyApp) return true;
  if (before.computerExcel !== after.computerExcel) return true;
  if (JSON.stringify(before.computerAllowedApps ?? []) !== JSON.stringify(after.computerAllowedApps ?? [])) return true;
  // Any provider edit can change what the child is launched with (model, base
  // URL, API format, the model catalog). Compare the list as a whole rather
  // than field by field: a new provider, a removed one and an edited one all
  // land here, and a spurious restart costs one process respawn.
  return JSON.stringify(previous.providers ?? []) !== JSON.stringify(next.providers ?? []);
}

module.exports = { settingsNeedAgentRestart };
