'use strict';

// Oracle Academy sign-in helpers.
//
// Two ways in:
//   1. loginWithDefaultBrowser — reuse the default browser's existing Oracle
//      session by importing its cookies (no login if already signed in).
//   2. login — open Oracle SSO in the Playwright browser and wait for the user
//      to sign in by hand.
//
// Oracle IDCS flow (case 2):
//   academy.oracle.com/pls/f?p=63000
//     -> https://signon.oracle.com/signin
//     -> [Username or email] -> Next
//     -> [Password] -> Sign In   (may be followed by MFA / account picker)
//     -> redirect back to academy.oracle.com
//
// We never type credentials: the user completes SSO by hand.

const { HUB_URL, isSignonUrl, isAcademyUrl, sessionStatus } = require('./browser');
const db = require('./default-browser');

const SIGNIN_HEADING = /sign in to oracle/i;
const POLL_MS = 3000;

/**
 * Wait until the browser is back on academy.oracle.com with no sign-in form.
 * @returns {Promise<{ok: boolean, url: string}>}
 */
async function waitForSignIn(page, { timeoutMs = 5 * 60 * 1000, onUrl = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== last) {
      onUrl(url);
      last = url;
    }
    if (isAcademyUrl(url) && !isSignonUrl(url)) {
      const stillSignin = await page
        .getByRole('heading', { name: SIGNIN_HEADING })
        .count()
        .catch(() => 0);
      if (stillSignin === 0) return { ok: true, url };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false, url: page.url() };
}

/**
 * Open the hub (or a custom URL) in the Playwright browser and wait for SSO.
 * @param {import('playwright').BrowserContext} context
 */
async function login(context, opts = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(opts.hub || HUB_URL, { waitUntil: 'domcontentloaded' });
  return waitForSignIn(page, opts);
}

/**
 * Open the hub in the Playwright browser and let the user confirm each attempt
 * (e.g. by pressing y). No cookie store access, so no Full Disk Access needed.
 * @param {import('playwright').BrowserContext} context
 * @param {object} opts { hub?, confirm, onStatus?, timeoutMs? }
 */
async function loginInteractive(context, opts = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(opts.hub || HUB_URL, { waitUntil: 'domcontentloaded' });

  const confirm = opts.confirm;
  const onStatus = opts.onStatus || (() => {});
  const deadline = Date.now() + (opts.timeoutMs || 10 * 60 * 1000);

  while (Date.now() < deadline) {
    if (confirm) {
      const go = await confirm();
      if (!go) return { ok: false, cancelled: true };
    } else {
      await page.waitForTimeout(2500);
    }
    const st = await sessionStatus(context);
    onStatus(st);
    if (st.status === 'in') return { ok: true, url: st.url };
  }
  return { ok: false };
}

/**
 * Reuse the default browser's Oracle session.
 *
 * Opens the hub in the default browser, watches its cookie store, and on each
 * change imports the cookies into a fresh Playwright context and verifies the
 * session. The Playwright context is created lazily and closed before returning;
 * the cookies are persisted into the profile.
 *
 * @param {object} opts { context, browser?, hub?, domains?, timeoutMs?, onUrl?,
 *                        onImport?, onStatus?, confirm? }
 *   confirm: async () => boolean. When provided, the tool opens the browser and
 *   waits for the user to confirm (e.g. press y) before capturing the session;
 *   it asks again on each failed attempt until the session verifies or the user
 *   cancels. Without confirm it polls the cookie store automatically.
 */
async function loginWithDefaultBrowser(opts = {}) {
  const context = opts.context;
  if (!context) throw new Error('loginWithDefaultBrowser requires opts.context');

  const browser = db.detectDefaultBrowser(opts.browser);
  const readable = db.cookieStoreReadable(browser);
  if (!readable.ok) {
    const err = new Error(readable.error || 'Cookie store not readable');
    err.code = readable.reason;
    throw err;
  }

  const hub = opts.hub || HUB_URL;
  const domains = opts.domains || db.DEFAULT_DOMAINS;
  const confirm = opts.confirm;
  const onUrl = opts.onUrl || (() => {});
  const onImport = opts.onImport || (() => {});
  const onStatus = opts.onStatus || (() => {});

  onUrl(hub);
  db.openInDefaultBrowser(hub);

  const deadline = Date.now() + (opts.timeoutMs || 5 * 60 * 1000);
  let lastSig = null;
  let imported = 0;

  while (Date.now() < deadline) {
    if (confirm) {
      const go = await confirm();
      if (!go) return { ok: false, cancelled: true, browser, imported };
    } else {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    let cookies = [];
    try {
      cookies = db.readCookies(browser, { domains });
    } catch (err) {
      onStatus({ status: 'read-error', error: String(err && err.message) });
      continue;
    }
    if (!cookies.length) {
      onStatus({ status: 'no-cookies' });
      continue;
    }

    const sig = db.cookieSignature(cookies);
    if (!confirm && sig === lastSig) continue;
    lastSig = sig;

    imported = await db.importCookies(context, cookies);
    onImport(imported);
    const st = await sessionStatus(context);
    onStatus(st);
    if (st.status === 'in') return { ok: true, browser, imported, url: st.url };
  }
  return { ok: false, browser, imported };
}

module.exports = {
  login,
  loginInteractive,
  waitForSignIn,
  loginWithDefaultBrowser,
  SIGNIN_HEADING
};
