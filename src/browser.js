'use strict';

// Persistent-context browser helper for Oracle Academy.
//
// Oracle Academy auth is Oracle IDCS SSO: any protected page redirects to
// https://signon.oracle.com/signin, the user signs in once (username -> Next ->
// password -> Sign In, possibly MFA), and is redirected back to
// academy.oracle.com. We log in once by hand and reuse the saved profile.
//
// Playwright is loaded lazily so `doctor` can report a missing install cleanly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME_URL =
  process.env.ORACLE_ACADEMY_HOME_URL ||
  'https://academy.oracle.com/en/oa-web-overview.html';

// Oracle Academy exposes two APEX hubs. Hitting either while signed out
// bounces to SSO. 63000 (Student Hub) is the default because student course
// links live there (e.g. .../pls/f?p=63000:190:...).
const MEMBER_HUB_URL = 'https://academy.oracle.com/pls/f?p=62000'; // Member Hub
const STUDENT_HUB_URL = 'https://academy.oracle.com/pls/f?p=63000'; // Student Hub

const HUB_URL = process.env.ORACLE_ACADEMY_HUB_URL || STUDENT_HUB_URL;

const ACADEMY_HOST = 'academy.oracle.com';
const SIGNON_HOST = 'signon.oracle.com';

// Oracle's Akamai edge serves this interstitial to detected headless browsers.
const BLOCKED_RE = /technical issue|technical difficulties|currently experiencing technical/i;

const INSTALL_HINT =
  'Playwright/Chromium is not ready. Fix it with:\n' +
  '  oracle-academy doctor --fix\n' +
  'or manually:\n' +
  '  npm install\n' +
  '  npx playwright install chromium';

function profileDir() {
  return (
    process.env.ORACLE_ACADEMY_PROFILE ||
    path.join(os.homedir(), '.oracle-academy', 'profile')
  );
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const err = new Error('The "playwright" package is not installed.\n\n' + INSTALL_HINT);
    err.code = 'PLAYWRIGHT_MISSING';
    throw err;
  }
}

/**
 * Check whether Playwright and its Chromium browser are installed.
 * @returns {{ok: boolean, playwright: boolean, chromium: boolean, executablePath?: string, reason?: string}}
 */
function checkPlaywright() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { ok: false, playwright: false, chromium: false, reason: 'playwright package not installed' };
  }
  let exe;
  try {
    exe = chromium.executablePath();
  } catch {
    return { ok: false, playwright: true, chromium: false, reason: 'cannot resolve Chromium path' };
  }
  if (!exe || !fs.existsSync(exe)) {
    return {
      ok: false,
      playwright: true,
      chromium: false,
      executablePath: exe,
      reason: 'Chromium browser not downloaded'
    };
  }
  return { ok: true, playwright: true, chromium: true, executablePath: exe };
}

function launchOptions(opts = {}) {
  // Oracle Academy's edge blocks headless Chromium (shows a "Technical Issue"
  // page), so headed is the safe default. Headless is opt-in via --headless.
  const headless = opts.headless === true;
  const args = ['--no-first-run', '--no-default-browser-check'];
  return {
    headless,
    args,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false
  };
}

/**
 * Launch a persistent Chromium context (shares the saved Oracle SSO profile).
 * @param {object} [opts] { headless?: boolean, channel?: string }
 */
async function launch(opts = {}) {
  const { chromium } = loadPlaywright();

  const check = checkPlaywright();
  if (!check.ok) throw new Error(check.reason + '.\n\n' + INSTALL_HINT);

  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  const options = launchOptions(opts);
  if (opts.channel) options.channel = opts.channel;

  try {
    const context = await chromium.launchPersistentContext(dir, options);
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(45000);
    return context;
  } catch (err) {
    const msg = String(err && err.message);
    if (/Executable doesn't exist|download new browsers|playwright install/i.test(msg)) {
      throw new Error('Chromium is missing or out of date.\n\n' + INSTALL_HINT);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* persistent browser (survives across commands, keeps session cookies) */
/* ------------------------------------------------------------------ */

// Oracle Academy's APEX session cookie (ORA_WWV_APP_63000) is a *session*
// cookie, so Chromium drops it when the browser closes and the server then
// rejects the stale session. Keeping one browser alive and attaching to it over
// CDP preserves the live session across commands.
const DEBUG_PORT = Number(process.env.ORACLE_ACADEMY_DEBUG_PORT || 9333);
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

async function debugReady(timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${DEBUG_URL}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function spawnBrowser() {
  const { chromium } = loadPlaywright();
  const exe = chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) throw new Error('Chromium is missing.\n\n' + INSTALL_HINT);
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(
    exe,
    [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Needed when running as root in a container and for small /dev/shm.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      'about:blank'
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  return child.pid;
}

/** List CDP targets on the shared browser (empty on any failure). */
async function listTargets(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${DEBUG_URL}/json/list`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

// Chrome 153+ can start with no page target, which makes connectOverCDP throw
// "Browser context management is not supported". Create one over the DevTools
// HTTP endpoint so there is a default context to attach to.
async function ensurePageTarget() {
  const targets = await listTargets();
  if (targets.some((t) => t.type === 'page')) return true;
  for (const method of ['PUT', 'GET']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${DEBUG_URL}/json/new?about:blank`, {
        method,
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      /* try the other method */
    }
  }
  return false;
}

/**
 * Attach to the shared Oracle Academy browser, starting it if needed. The
 * browser is left running when the caller disconnects, so the logged-in session
 * (including session cookies) is preserved for later commands.
 * @returns {Promise<{browser: import('playwright').Browser, context: import('playwright').BrowserContext, reused: boolean, port: number}>}
 */
async function ensureBrowser() {
  const { chromium } = loadPlaywright();
  let reused = await debugReady();
  if (!reused) {
    spawnBrowser();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await debugReady()) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!(await debugReady())) {
      throw new Error(`The Oracle Academy browser did not start on port ${DEBUG_PORT}.`);
    }
  }
  await ensurePageTarget();
  let browser;
  try {
    browser = await chromium.connectOverCDP(DEBUG_URL);
  } catch (err) {
    if (!/context management is not supported|setDownloadBehavior/i.test(String(err && err.message))) {
      throw err;
    }
    await ensurePageTarget();
    browser = await chromium.connectOverCDP(DEBUG_URL);
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(45000);
  return { browser, context, reused, port: DEBUG_PORT };
}

/** Disconnect from the shared browser without closing it. */
async function disconnect(browser) {
  try {
    await browser.close();
  } catch {
    /* already gone */
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when the URL is Oracle's SSO/identity host (i.e. still signing in). */
function isSignonUrl(url) {
  const h = hostOf(url);
  return (
    h === SIGNON_HOST ||
    h.endsWith('.' + SIGNON_HOST) ||
    h.endsWith('.identity.oraclecloud.com')
  );
}

/** True when the URL is on the Oracle Academy application host. */
function isAcademyUrl(url) {
  const h = hostOf(url);
  return h === ACADEMY_HOST || h.endsWith('.' + ACADEMY_HOST);
}

/** True when a page title/body looks like the edge's headless block page. */
function isBlockedPage(text) {
  return BLOCKED_RE.test(text || '');
}

// An APEX app page carries its session id in the URL
// (…/pls/f?p=<app>:<page>:<session>…). Navigating to the bare hub without it
// starts a *new* session and bounces to SSO, so we must reuse an open app page.
const APP_PAGE_RE = /\/pls\/f\?p=\d+:\d+:\d+/;

/** Return an already-open, signed-in Oracle Academy APEX page, if any. */
function findAppPage(context) {
  for (const p of context.pages()) {
    const url = p.url();
    if (APP_PAGE_RE.test(url) && !isSignonUrl(url) && isAcademyUrl(url)) return p;
  }
  return null;
}

/**
 * Classify the current session. Reuses an open app page when present; otherwise
 * navigates to the hub to trigger the SSO redirect.
 * @returns {Promise<{status: 'in'|'out'|'blocked'|'error', url?: string, title?: string, error?: string}>}
 */
async function sessionStatus(context) {
  const existing = findAppPage(context);
  if (existing) {
    const url = existing.url();
    const title = await existing.title().catch(() => '');
    if (isBlockedPage(title)) return { status: 'blocked', url, title };
    return { status: 'in', url, title };
  }

  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded' });
    // The hub can render briefly before a client-side redirect to SSO, so wait
    // for the URL to settle before deciding.
    let url = page.url();
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1000);
      const next = page.url();
      if (next === url && i >= 2) break;
      url = next;
    }
    const app = findAppPage(context);
    if (app) {
      return { status: 'in', url: app.url(), title: await app.title().catch(() => '') };
    }
    const title = await page.title().catch(() => '');
    if (isBlockedPage(title)) return { status: 'blocked', url, title };
    return { status: 'out', url, title };
  } catch (err) {
    return { status: 'error', error: String(err && err.message) };
  }
}

/**
 * Navigate to the Member Hub and report whether the saved profile is signed in.
 * A signed-out session gets bounced to signon.oracle.com.
 */
async function isLoggedIn(context) {
  return (await sessionStatus(context)).status === 'in';
}

module.exports = {
  launch,
  ensureBrowser,
  ensurePageTarget,
  listTargets,
  disconnect,
  debugReady,
  DEBUG_PORT,
  findAppPage,
  isLoggedIn,
  sessionStatus,
  profileDir,
  checkPlaywright,
  loadPlaywright,
  HOME_URL,
  HUB_URL,
  MEMBER_HUB_URL,
  STUDENT_HUB_URL,
  ACADEMY_HOST,
  SIGNON_HOST,
  hostOf,
  isSignonUrl,
  isAcademyUrl,
  isBlockedPage,
  INSTALL_HINT,
  launchOptions
};
