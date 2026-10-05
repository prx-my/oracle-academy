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

// Platform switch. macOS and Windows each get their own registry, detection and
// cookie decryption; the two paths never run together.
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Windows browser data lives under %LOCALAPPDATA% (Chromium) / %APPDATA% (Firefox).
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING_APP_DATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

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

// Windows canonical id -> browser descriptor. Chromium stores its profile under
// "User Data" (with a Local State file holding the DPAPI-encrypted key); Firefox
// keeps profiles under %APPDATA%\Mozilla\Firefox\Profiles.
const WIN_BROWSERS = {
  brave: {
    kind: 'chromium',
    name: 'Brave',
    progIds: ['BraveHTML'],
    dataDir: path.join(LOCAL_APP_DATA, 'BraveSoftware', 'Brave-Browser', 'User Data')
  },
  chrome: {
    kind: 'chromium',
    name: 'Chrome',
    progIds: ['ChromeHTML'],
    dataDir: path.join(LOCAL_APP_DATA, 'Google', 'Chrome', 'User Data')
  },
  edge: {
    kind: 'chromium',
    name: 'Edge',
    progIds: ['MSEdgeHTM'],
    dataDir: path.join(LOCAL_APP_DATA, 'Microsoft', 'Edge', 'User Data')
  },
  chromium: {
    kind: 'chromium',
    name: 'Chromium',
    progIds: ['ChromiumHTM'],
    dataDir: path.join(LOCAL_APP_DATA, 'Chromium', 'User Data')
  },
  arc: {
    kind: 'chromium',
    name: 'Arc',
    progIds: ['ArcHTML'],
    dataDir: path.join(LOCAL_APP_DATA, 'Arc', 'User Data')
  },
  firefox: {
    kind: 'firefox',
    name: 'Firefox',
    progIds: ['FirefoxURL'],
    dataDir: path.join(ROAMING_APP_DATA, 'Mozilla', 'Firefox')
  }
};

// Friendly aliases for --browser on Windows.
const WIN_ALIASES = {
  brave: 'brave',
  chrome: 'chrome',
  edge: 'edge',
  chromium: 'chromium',
  arc: 'arc',
  firefox: 'firefox'
};

const DEFAULT_DOMAINS = ['oracle'];

const FDA_HINT = IS_WIN
  ? 'Windows blocked reading the browser cookie store.\n' +
    '  Close the browser, then re-run (or use "oracle-academy login --playwright").'
  : 'macOS blocked reading the browser cookie store (Full Disk Access required).\n' +
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

function defaultBrowserProgId() {
  if (!IS_WIN) return null;
  const key =
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'ProgId'], { encoding: 'utf8' });
    const m = out.match(/ProgId\s+REG_SZ\s+(.+)/i);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Resolve a Windows default-browser ProgId (e.g. "FirefoxURL-3080...") to a canonical id. */
function canonicalFromProgId(progId) {
  if (!progId) return null;
  const k = String(progId).toLowerCase();
  for (const [id, def] of Object.entries(WIN_BROWSERS)) {
    if ((def.progIds || []).some((p) => k === p.toLowerCase() || k.startsWith(p.toLowerCase()))) {
      return id;
    }
  }
  return null;
}

function browserByKey(key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  if (IS_WIN) {
    const id = WIN_ALIASES[k] || canonicalFromProgId(k);
    const desc = id ? WIN_BROWSERS[id] : null;
    return desc ? { id, ...desc } : null;
  }
  const bundle = ALIASES[k] || key;
  const desc = BROWSERS[bundle];
  return desc ? { bundle, ...desc } : null;
}

/** Detect the OS default browser, or resolve an explicit --browser override. */
function detectDefaultBrowser(override) {
  const supported = Object.keys(IS_WIN ? WIN_ALIASES : ALIASES);
  if (override) {
    const b = browserByKey(override);
    if (!b) {
      throw new Error(
        `Unknown browser "${override}". Try: ${supported.join(', ')}`
      );
    }
    return b;
  }
  const detected = IS_WIN ? defaultBrowserProgId() : defaultBrowserBundleId();
  const b = browserByKey(detected);
  if (!b) {
    throw new Error(
      `Default browser "${detected || 'unknown'}" is not supported.\n` +
        'Supported: ' + supported.join(', ') +
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

function hasSqliteReader() {
  const sqlite = getNodeSqlite();
  if (sqlite && sqlite.DatabaseSync) return true;
  try {
    execFileSync(IS_WIN ? 'where' : 'which', ['sqlite3'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function cookieStoreReadable(browser) {
  try {
    fs.readdirSync(browser.dataDir);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return { ok: false, reason: 'full-disk-access', error: FDA_HINT };
    }
    return { ok: false, reason: 'missing', error: String(err && err.message) };
  }
  // On Windows there is no guaranteed `sqlite3` binary; require Node's built-in
  // SQLite so we fail fast (and fall back to --playwright) instead of looping.
  if (IS_WIN && browser.kind === 'chromium') {
    if (!fs.existsSync(path.join(browser.dataDir, 'Local State'))) {
      return {
        ok: false,
        reason: 'no-key',
        error: `No "Local State" in ${browser.dataDir}; use "oracle-academy login --playwright".`
      };
    }
    if (!hasSqliteReader()) {
      return {
        ok: false,
        reason: 'sqlite-unavailable',
        error:
          'Reading Windows cookies needs Node.js >= 22.5 (built-in SQLite) or a ' +
          'sqlite3 binary on PATH. Use "oracle-academy login --playwright" instead.'
      };
    }
  }
  return { ok: true };
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

// Chromium's cookie key: a Keychain-derived PBKDF2 key on macOS, a DPAPI-
// protected key from "Local State" on Windows. The two never mix.
function chromiumKey(browser) {
  return IS_WIN ? windowsChromiumKey(browser) : macChromiumKey(browser);
}

function macChromiumKey(browser) {
  const pw = execFileSync(
    'security',
    ['find-generic-password', '-s', browser.keychainService, '-a', browser.keychainAccount, '-w'],
    { encoding: 'utf8' }
  ).trim();
  return crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

// Unprotect a DPAPI blob (CurrentUser scope) via PowerShell's ProtectedData.
function dpapiUnprotect(blob) {
  const b64 = blob.toString('base64');
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    `$b=[Convert]::FromBase64String("${b64}"); ` +
    '$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,' +
    '[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Convert]::ToBase64String($d)';
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
  }
  return Buffer.from(out.trim(), 'base64');
}

function windowsChromiumKey(browser) {
  const localState = path.join(browser.dataDir, 'Local State');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(localState, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${localState}: ${err.message}`);
  }
  const b64 = raw && raw.os_crypt && raw.os_crypt.encrypted_key;
  if (!b64) {
    throw new Error(
      'No DPAPI key in "Local State" (os_crypt.encrypted_key). Newer Chromium ' +
        'may use App-Bound Encryption; use "oracle-academy login --playwright".'
    );
  }
  let blob = Buffer.from(b64, 'base64');
  if (blob.slice(0, 5).toString('utf8') === 'DPAPI') blob = blob.subarray(5);
  return dpapiUnprotect(blob);
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

let nodeSqlite;
let nodeSqliteChecked = false;

// Node's built-in SQLite (Node >= 22.5) avoids requiring a `sqlite3` binary,
// which isn't installed on Windows by default.
function getNodeSqlite() {
  if (!nodeSqliteChecked) {
    nodeSqliteChecked = true;
    try {
      nodeSqlite = require('node:sqlite');
    } catch {
      nodeSqlite = null;
    }
  }
  return nodeSqlite;
}

function querySqliteJson(dbFile, sql) {
  // Windows has no guaranteed `sqlite3` CLI, so prefer the built-in module.
  if (IS_WIN) {
    const sqlite = getNodeSqlite();
    if (sqlite && sqlite.DatabaseSync) {
      const database = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        return database.prepare(sql).all();
      } finally {
        database.close();
      }
    }
  }
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

// Windows Chromium (>= 80) uses AES-256-GCM: "v10" + nonce(12) + ciphertext +
// tag(16), with a 32-byte DPAPI-protected key. "v20" is App-Bound Encryption and
// can't be decrypted here.
function decryptChromiumValueWin(encHex, key) {
  if (!encHex) return '';
  const buf = Buffer.from(encHex, 'hex');
  const prefix = buf.slice(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString('utf8');
  if (buf.length < 3 + 12 + 16) return '';
  try {
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(15, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
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
        const value = r.enc
          ? IS_WIN
            ? decryptChromiumValueWin(r.enc, key)
            : decryptChromiumValue(r.enc, r.host_key, key)
          : r.value || '';
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
  defaultBrowserProgId,
  canonicalFromProgId,
  openInDefaultBrowser,
  cookieStoreReadable,
  readCookies,
  importCookies,
  cookieSignature,
  chromiumKey,
  windowsChromiumKey,
  decryptChromiumValue,
  decryptChromiumValueWin,
  chromeTimeToUnix,
  sameSiteFromChromium,
  profileDirs,
  BROWSERS,
  WIN_BROWSERS,
  ALIASES,
  WIN_ALIASES,
  DEFAULT_DOMAINS,
  FDA_HINT
};
