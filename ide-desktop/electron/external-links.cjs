'use strict';

/** Which URLs the shell may hand to the OS.
 *
 *  main.cjs has two paths that can receive a URL from page content: a
 *  navigation attempt in the main window, and a `target="_blank"` link. Both
 *  must apply the same rule. shell.openExternal launches whatever handler a
 *  scheme is registered to — a `file:///` link opens a local file in its
 *  default app, and a custom scheme launches the registered program — so only
 *  ordinary web URLs are allowed through.
 */

const WEB_SCHEMES = new Set(['http:', 'https:']);

/** True when the URL is an ordinary http(s) URL. Anything unparseable, a
 *  file: URL, or a custom scheme is refused. */
function isExternalWebUrl(target) {
  if (typeof target !== 'string' || !target) return false;
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return WEB_SCHEMES.has(url.protocol);
}

module.exports = { isExternalWebUrl, WEB_SCHEMES };
