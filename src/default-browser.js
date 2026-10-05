'use strict';

// Reuse the OS default browser's existing Oracle Academy session.
//
// Oracle Academy's SSO cookies live in the browser's own cookie store. We read
// them from the default browser (Brave/Chrome/Edge/Chromium/Arc or Firefox),
// decrypt Chromium values with the Keychain key, and import them into the
// Playwright persistent profile. If the user is already signed in to Oracle
// Academy in that browser, no login is needed at all.
//
// macOS protects other apps' cookie stores with Full Disk Access (TCC). When the
// store can't be read we surface a clear "grant Full Disk Access" message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const HOME = os.homedir();
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support');

// macOS bundle id -> browser descriptor.
const BROWSERS = {
  'com.brave.browser': {
    kind: 'chromium',
    name: 'Brave',
    dataDir: path.join(APP_SUPPORT, 'BraveSoftware', 'Brave-Browser'),
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave'
  },
  'com.google.chrome': {
    kind: 'chromium',
    name: 'Chrome',
    dataDir: path.join(APP_SUPPORT, 'Google', 'Chrome'),
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome'
  },
  'com.microsoft.edgemac': {
    kind: 'chromium',
    name: 'Edge',
    dataDir: path.join(APP_SUPPORT, 'Microsoft Edge'),
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge'
  },
  'org.chromium.Chromium': {
    kind: 'chromium',
    name: 'Chromium',
    dataDir: path.join(APP_SUPPORT, 'Chromium'),
    keychainService: 'Chromium Safe Storage',
    keychainAccount: 'Chromium'
  },
  'company.thebrowser.Browser': {
    kind: 'chromium',
    name: 'Arc',
    dataDir: path.join(APP_SUPPORT, 'Arc'),
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc'
  },
  'org.mozilla.firefox': {
    kind: 'firefox',
    name: 'Firefox',
    dataDir: path.join(APP_SUPPORT, 'Firefox')
  }
};

// Friendly aliases for --browser.
const ALIASES = {
  brave: 'com.brave.browser',
  chrome: 'com.google.chrome',
  edge: 'com.microsoft.edgemac',
  chromium: 'org.chromium.Chromium',
  arc: 'company.thebrowser.Browser',
  firefox: 'org.mozilla.firefox'
};

const DEFAULT_DOMAINS = ['oracle'];

const FDA_HINT =
  'macOS blocked reading the browser cookie store (Full Disk Access required).\n' +
  '  System Settings > Privacy & Security > Full Disk Access\n' +
  '  -> enable the app you run this command from (Terminal / iTerm / your editor),\n' +
  '  -> then re-run. The browser may need to be running so the store is current.';

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

function defaultBrowserBundleId() {
  if (process.platform !== 'darwin') return null;
  const plist = path.join(
    HOME,
    'Library',
    'Preferences',
    'com.apple.LaunchServices',
    'com.apple.launchservices.secure.plist'
  );
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8'
    });
    const handlers = JSON.parse(json).LSHandlers || [];
    const https = handlers.find(
      (h) => h.LSHandlerURLScheme === 'https' && h.LSHandlerRoleAll
    );
    return https ? https.LSHandlerRoleAll : null;
  } catch {
    return null;
  }
}

function browserByKey(key) {
  if (!key) return null;
  const bundle = ALIASES[String(key).toLowerCase()] || key;
  const desc = BROWSERS[bundle];
  return desc ? { bundle, ...desc } : null;
}

/** Detect the OS default browser, or resolve an explicit --browser override. */
function detectDefaultBrowser(override) {
  if (override) {
    const b = browserByKey(override);
    if (!b) {
      throw new Error(
        `Unknown browser "${override}". Try: ${Object.keys(ALIASES).join(', ')}`
      );
    }
    return b;
  }
  const bundle = defaultBrowserBundleId();
  const b = browserByKey(bundle);
  if (!b) {
    throw new Error(
      `Default browser "${bundle || 'unknown'}" is not supported.\n` +
        'Supported: ' + Object.keys(ALIASES).join(', ') +
        '. Or use "oracle-academy login --playwright".'
    );
  }
  return b;
}

function openInDefaultBrowser(url) {
  const child =
    process.platform === 'darwin'
      ? spawn('open', [url], { stdio: 'ignore', detached: true })
      : process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.unref();
}

/* ------------------------------------------------------------------ */
/* access checks                                                       */
/* ------------------------------------------------------------------ */

function cookieStoreReadable(browser) {
  try {
    fs.readdirSync(browser.dataDir);
    return { ok: true };
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return { ok: false, reason: 'full-disk-access', error: FDA_HINT };
    }
    return { ok: false, reason: 'missing', error: String(err && err.message) };
  }
}

/* ------------------------------------------------------------------ */
/* reading + decrypting                                                */
/* ------------------------------------------------------------------ */

function profileDirs(browser) {
  if (browser.kind === 'firefox') return firefoxProfileDirs(browser);
  const dirs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(browser.dataDir);
  } catch {
    return dirs;
  }
  for (const name of entries) {
    if (name === 'Guest Profile' || name === 'System Profile') continue;
    if (name !== 'Default' && !/^Profile /.test(name)) continue;
    if (fs.existsSync(path.join(browser.dataDir, name, 'Cookies'))) dirs.push(name);
  }
  return dirs;
}

function firefoxProfileDirs(browser) {
  const root = path.join(browser.dataDir, 'Profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((n) => fs.existsSync(path.join(root, n, 'cookies.sqlite')))
    .map((n) => path.join('Profiles', n));
}

function chromiumKey(browser) {
  const pw = execFileSync(
    'security',
    ['find-generic-password', '-s', browser.keychainService, '-a', browser.keychainAccount, '-w'],
    { encoding: 'utf8' }
  ).trim();
  return crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

function copyToTemp(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-cookies-'));
  const dest = path.join(dir, path.basename(file));
  fs.copyFileSync(file, dest);
  for (const suffix of ['-wal', '-shm']) {
    const extra = file + suffix;
    if (fs.existsSync(extra)) {
      try {
        fs.copyFileSync(extra, dest + suffix);
      } catch {
        /* best effort */
      }
    }
  }
  return { dir, dest };
}

function whereDomains(domains) {
  return domains.map((d) => `host_key like '%${d}%'`).join(' or ');
}

function querySqliteJson(dbFile, sql) {
  const out = execFileSync('sqlite3', ['-json', dbFile, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return out.trim() ? JSON.parse(out) : [];
}

function decryptChromiumValue(encHex, hostKey, key) {
  if (!encHex) return '';
  const buf = Buffer.from(encHex, 'hex');
  const prefix = buf.slice(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString('utf8');
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    let dec = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
    // Chrome >= 80 prepends sha256(host_key); strip it when it matches.
    const hash = crypto.createHash('sha256').update(hostKey).digest();
    if (dec.length >= 32 && dec.slice(0, 32).equals(hash)) dec = dec.slice(32);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

function chromeTimeToUnix(expiresUtc) {
  const n = Number(expiresUtc);
  if (!n) return -1;
  return Math.round(n / 1e6 - 11644473600);
}

function sameSiteFromChromium(v) {
  const n = Number(v);
  if (n === 1) return 'Lax';
  if (n === 2) return 'Strict';
  if (n === 0) return 'None';
  return undefined;
}

function readChromiumCookies(browser, opts = {}) {
  const domains = opts.domains || DEFAULT_DOMAINS;
  const key = chromiumKey(browser);
  const cookies = [];
  for (const profile of profileDirs(browser)) {
    const db = path.join(browser.dataDir, profile, 'Cookies');
    if (!fs.existsSync(db)) continue;
    const { dir, dest } = copyToTemp(db);
    try {
      const rows = querySqliteJson(
        dest,
        `select host_key,name,hex(encrypted_value) as enc,value,path,expires_utc,is_secure,is_httponly,samesite from cookies where ${whereDomains(domains)};`
      );
      for (const r of rows) {
        const value = r.enc ? decryptChromiumValue(r.enc, r.host_key, key) : r.value || '';
        cookies.push({
          name: r.name,
          value,
          domain: r.host_key,
          path: r.path || '/',
          expires: chromeTimeToUnix(r.expires_utc),
          secure: !!Number(r.is_secure),
          httpOnly: !!Number(r.is_httponly),
          sameSite: sameSiteFromChromium(r.samesite)
        });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return cookies;
}

function sameSiteFromFirefox(v) {
  const n = Number(v);
  if (n === 1) return 'Lax';
  if (n === 2) return 'Strict';
  if (n === 0) return 'None';
  return undefined;
}

function readFirefoxCookies(browser, opts = {}) {
  const domains = opts.domains || DEFAULT_DOMAINS;
  const cookies = [];
  for (const profile of profileDirs(browser)) {
    const db = path.join(browser.dataDir, profile, 'cookies.sqlite');
    if (!fs.existsSync(db)) continue;
    const { dir, dest } = copyToTemp(db);
    try {
      const rows = querySqliteJson(
        dest,
        `select host as host_key,name,value,path,expiry,isSecure,isHttpOnly,sameSite from moz_cookies where ${whereDomains(domains)};`
      );
      for (const r of rows) {
        cookies.push({
          name: r.name,
          value: r.value || '',
          domain: r.host_key,
          path: r.path || '/',
          expires: Number(r.expiry) || -1,
          secure: !!Number(r.isSecure),
          httpOnly: !!Number(r.isHttpOnly),
          sameSite: sameSiteFromFirefox(r.sameSite)
        });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return cookies;
}

function readCookies(browser, opts = {}) {
  return browser.kind === 'firefox'
    ? readFirefoxCookies(browser, opts)
    : readChromiumCookies(browser, opts);
}

/* ------------------------------------------------------------------ */
/* import into Playwright                                              */
/* ------------------------------------------------------------------ */

async function importCookies(context, cookies) {
  const payload = [];
  for (const c of cookies) {
    if (!c || !c.name || !c.domain || c.value == null || c.value === '') continue;
    const entry = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure
    };
    // Playwright rejects SameSite=None without Secure.
    if (c.sameSite && !(c.sameSite === 'None' && !c.secure)) entry.sameSite = c.sameSite;
    payload.push(entry);
  }
  if (payload.length) await context.addCookies(payload);
  return payload.length;
}

function cookieSignature(cookies) {
  return cookies
    .map((c) => `${c.domain}\t${c.name}\t${c.value}`)
    .sort()
    .join('\n');
}

module.exports = {
  detectDefaultBrowser,
  defaultBrowserBundleId,
  openInDefaultBrowser,
  cookieStoreReadable,
  readCookies,
  importCookies,
  cookieSignature,
  chromiumKey,
  decryptChromiumValue,
  chromeTimeToUnix,
  sameSiteFromChromium,
  profileDirs,
  BROWSERS,
  ALIASES,
  DEFAULT_DOMAINS,
  FDA_HINT
};
