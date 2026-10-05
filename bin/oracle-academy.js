#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');
const { spawnSync } = require('child_process');
const oa = require('../src');

const pkg = require('../package.json');

const HELP = `
oracle-academy v${pkg.version} — drive Oracle Academy (Student Hub) with a saved Oracle SSO session

Usage:
  oracle-academy login   [--browser brave|chrome|edge|arc|firefox] [--hub <url>]
                         Opens the Student Hub in your default browser, waits while
                         you sign in, then (after you press y) imports the session.
                         --poll watches cookies automatically instead of asking.
  oracle-academy login   --playwright [--channel chrome]
                         Instead, sign in by hand in the Playwright browser.
  oracle-academy cookies [--browser <name>]
                         Diagnose: default browser, cookie store access, cookies.
  oracle-academy whoami
  oracle-academy dump    [--url <url>] [--json <file>]
                         Print the page structure (headings, links, buttons, forms).
                         Defaults to the Student Hub. Use it to map APEX pages.
  oracle-academy list    [--json <file>]
                         List your classes in the Student Hub (My Classes).
  oracle-academy sections --class <classCourseId> [--json <file>]
                         List a class's sections.
  oracle-academy items   --class <classCourseId> --section <sectionP15Id> [--json <file>]
                         List a section's items (slides, guides, practices, quizzes).
  oracle-academy quiz    read [--json <file>]
                         Read the current question and choices.
  oracle-academy quiz    answer <letters> [--no-submit]
                         Select choices (a,b,c; join with + for multi) and submit.
  oracle-academy quiz    run [--provider gemini|openai] [--model <m>] [--dry-run]
                         Auto-answer every question and complete the assessment.
                         Add --class/--section/--item to start the quiz first.
  oracle-academy quiz    complete
                         Complete the assessment attempt.
  oracle-academy quiz    start --class <id> --section <sid> --item <iid>
                         Open a quiz item and begin the assessment.
  oracle-academy open    --url <url>
                         Open a page in the shared browser (which stays running).
  oracle-academy doctor  [--fix]
                         Check Node, Playwright, Chromium, browser and login.

Notes:
  login opens one browser that stays running; other commands attach to it over
  CDP and reuse the live session. Close that window when you're done.

Options:
  --browser <name>    Override the default browser: brave, chrome, edge, arc, firefox.
  --playwright        Sign in via the Playwright browser instead of cookie import.
  --poll              Watch the cookie store automatically (no y prompt).
  --provider <name>   Answer engine for "quiz run": gemini (default) or openai.
  --model <name>      Model override for the provider.
  --hub <url>         URL opened for login (default: Student Hub).
  --url <url>         Target page for dump/open.
  --json <file>       Write the full dump as JSON.

Environment:
  ORACLE_ACADEMY_PROFILE    Override the browser profile dir (~/.oracle-academy/profile).
  ORACLE_ACADEMY_HUB_URL    Override the Member Hub URL.
  ORACLE_ACADEMY_HOME_URL   Override the public home URL.

Examples:
  oracle-academy login
  oracle-academy whoami
  oracle-academy dump --url "https://academy.oracle.com/pls/f?p=62000" --json hub.json
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (
        key === 'help' ||
        key === 'version' ||
        key === 'headless' ||
        key === 'playwright' ||
        key === 'poll' ||
        key === 'dry-run' ||
        key === 'no-submit'
      ) {
        out[key] = true;
      } else if (key === 'json') {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out.json = next;
          i++;
        } else {
          out.json = true;
        }
      } else {
        out[key] = argv[i + 1];
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function waitForYes(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// Attach to the shared, long-lived browser. Disconnecting leaves it running so
// the logged-in session (session cookies included) survives between commands.
async function withBrowser(fn) {
  const { browser, context } = await oa.ensureBrowser();
  try {
    return await fn(context);
  } finally {
    await oa.disconnect(browser);
  }
}

async function cmdLogin(opts) {
  if (opts.playwright) return cmdLoginPlaywright(opts);

  let browser = null;
  let readable = { ok: false };
  try {
    browser = oa.detectDefaultBrowser(opts.browser);
    readable = oa.cookieStoreReadable(browser);
  } catch {
    browser = null; // no supported default browser (e.g. Linux) — use the tool browser
  }

  if (!readable.ok) {
    if (browser) {
      process.stdout.write(
        `\n${browser.name}'s cookie store is blocked by macOS (Full Disk Access required).\n` +
          'Falling back to signing in in the tool browser — no permissions needed.\n' +
          'To reuse your default browser instead, grant Full Disk Access and re-run.\n'
      );
    } else {
      process.stdout.write('\nSigning in in the tool browser.\n');
    }
    return cmdLoginPlaywright(opts);
  }

  return cmdLoginDefaultBrowser(opts, browser);
}

async function cmdLoginDefaultBrowser(opts, browserDesc) {
  const interactive = process.stdin.isTTY && !opts.poll;
  const { browser, context } = await oa.ensureBrowser();
  try {
    const res = await oa.loginWithDefaultBrowser({
      context,
      browser: opts.browser,
      hub: opts.hub,
      confirm: interactive
        ? () =>
            waitForYes(
              '\nSign in to Oracle Academy in the browser, then press y to continue (n to cancel): '
            )
        : undefined,
      onUrl: (url) => process.stdout.write(`Opening in your default browser: ${url}\n`),
      onImport: (n) => process.stdout.write(`  imported ${n} cookie(s), verifying...\n`),
      onStatus: (st) => {
        if (st.status === 'in') return;
        if (st.status === 'blocked') {
          process.stdout.write('  (edge served the block page; will retry)\n');
        } else if (st.status === 'out') {
          process.stdout.write('  not signed in yet — finish signing in, then press y again\n');
        } else if (st.status === 'no-cookies') {
          process.stdout.write('  no Oracle cookies found yet — sign in in the browser\n');
        } else if (st.status === 'read-error') {
          process.stdout.write(`  cookie read error: ${st.error}\n`);
        }
      }
    });

    if (res.ok) {
      process.stdout.write(
        `\nSigned in via ${res.browser.name}. Keep the browser window open; other commands reuse it.\n`
      );
    } else if (res.cancelled) {
      process.stdout.write('\nCancelled.\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('\nTimed out waiting for confirmation. Re-run "oracle-academy login".\n');
      process.exitCode = 1;
    }
  } catch (err) {
    if (err.code === 'full-disk-access') {
      process.stderr.write(`\n${oa.FDA_HINT}\n`);
    } else {
      process.stderr.write(`\n${err.message}\n`);
    }
    process.exitCode = 1;
  } finally {
    await oa.disconnect(browser);
  }
}

async function cmdLoginPlaywright(opts) {
  const { browser, context } = await oa.ensureBrowser();
  const interactive = process.stdin.isTTY && !opts.poll;
  try {
    process.stdout.write(
      '\nA browser window is open. Sign in to Oracle Academy (Oracle SSO) there:\n' +
        '  username -> Next -> password -> Sign In  (MFA if prompted)\n\n'
    );

    const res = interactive
      ? await oa.loginInteractive(context, {
          hub: opts.hub,
          confirm: () =>
            waitForYes(
              'Sign in in the browser, then press y to continue (n to cancel): '
            ),
          onStatus: (st) => {
            if (st.status === 'in') return;
            if (st.status === 'out') {
              process.stdout.write('  not signed in yet — finish signing in, then press y again\n');
            } else if (st.status === 'blocked') {
              process.stdout.write('  (edge served the block page; will retry)\n');
            }
          }
        })
      : await oa.login(context, {
          hub: opts.hub,
          onUrl: (url) => process.stdout.write(`  ${url}\n`)
        });

    if (res.ok) {
      process.stdout.write(
        '\nSigned in. Keep the browser window open; other commands reuse it.\n'
      );
      process.exitCode = 0;
    } else if (res.cancelled) {
      process.stdout.write('\nCancelled.\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('\nTimed out waiting for sign-in. Re-run "oracle-academy login".\n');
      process.exitCode = 1;
    }
  } finally {
    await oa.disconnect(browser);
  }
}

function cmdCookies(opts) {
  let browser;
  try {
    browser = oa.detectDefaultBrowser(opts.browser);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nDefault browser: ${browser.name} (${browser.bundle})\n`);
  process.stdout.write(`Cookie store:    ${browser.dataDir}\n`);

  const readable = oa.cookieStoreReadable(browser);
  if (!readable.ok) {
    process.stdout.write('Readable:        no\n\n');
    process.stderr.write(`${readable.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Readable:        yes\n');

  let cookies = [];
  try {
    cookies = oa.readCookies(browser, { domains: ['oracle'] });
  } catch (err) {
    process.stderr.write(`Failed to read cookies: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Oracle cookies:  ${cookies.length}\n\n`);
  for (const c of cookies) {
    process.stdout.write(`  ${c.domain}  ${c.name}  (${c.value.length} chars)\n`);
  }
}

async function cmdWhoami(opts) {
  return withBrowser(async (context) => {
    const res = await oa.sessionStatus(context);
    if (res.status === 'in') {
      process.stdout.write(`Signed in. Profile: ${oa.profileDir()}\n`);
    } else if (res.status === 'blocked') {
      process.stdout.write(
        'Oracle Academy served the headless block page. Re-run without --headless.\n'
      );
      process.exitCode = 1;
    } else if (res.status === 'out') {
      process.stdout.write('Not signed in. Run "oracle-academy login".\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(`Could not determine session: ${res.error}\n`);
      process.exitCode = 1;
    }
  });
}

async function cmdDump(opts) {
  const url = opts.url || null; // null = dump the signed-in page already open
  return withBrowser(async (context) => {
    const dump = await oa.dumpPage(context, url);

    if (dump.blocked) {
      process.stderr.write(
        'Warning: Oracle Academy served the headless block page. Re-run without --headless.\n'
      );
    }

    if (opts.json) {
      const payload = JSON.stringify(dump, null, 2);
      if (opts.json === true) process.stdout.write(payload + '\n');
      else {
        fs.writeFileSync(opts.json, payload);
        process.stdout.write(`Wrote ${opts.json}\n`);
      }
      return;
    }

    process.stdout.write(`\n${dump.title}\n${dump.url}\n`);
    if (dump.apex) process.stdout.write(`APEX app ${dump.apex.app}, page ${dump.apex.page}\n`);

    process.stdout.write(`\nHeadings (${dump.headings.length})\n`);
    for (const h of dump.headings) process.stdout.write(`  ${h.level}  ${h.text}\n`);

    const links = oa.apexLinks(dump);
    process.stdout.write(`\nAPEX links (${links.length} of ${dump.links.length})\n`);
    for (const l of links) process.stdout.write(`  ${l.text || '(no text)'}\n    ${l.href}\n`);

    process.stdout.write(`\nButtons (${dump.buttons.length})\n`);
    for (const b of dump.buttons) process.stdout.write(`  ${b}\n`);

    process.stdout.write(`\nForms (${dump.forms.length})\n`);
    for (const f of dump.forms) {
      process.stdout.write(`  ${f.method.toUpperCase()} ${f.action} [${f.fields.map((x) => x.name || x.type).join(', ')}]\n`);
    }
    process.stdout.write('\nTip: re-run with --json <file> for the full list of links.\n');
  });
}

async function cmdList(opts) {
  return withBrowser(async (context) => {
    const { url, classes } = await oa.listClasses(context);

    if (opts.json) {
      const payload = JSON.stringify({ url, classes }, null, 2);
      if (opts.json === true) process.stdout.write(payload + '\n');
      else {
        fs.writeFileSync(opts.json, payload);
        process.stdout.write(`Wrote ${opts.json}\n`);
      }
      return;
    }

    process.stdout.write(`\nMy Classes (${classes.length})\n`);
    classes.forEach((c, i) => {
      process.stdout.write(`\n${i + 1}. ${c.name}\n`);
      if (c.meta) process.stdout.write(`   ${c.meta}\n`);
      process.stdout.write(`   classCourseId=${c.classCourseId} courseId=${c.courseId}\n`);
    });
    process.stdout.write('\n');
  });
}

async function cmdSections(opts) {
  const classCourseId = opts.class || opts._[1];
  if (!classCourseId) throw new Error('usage: sections --class <classCourseId>');
  return withBrowser(async (context) => {
    const { cls, sections } = await oa.listSections(context, classCourseId);
    if (opts.json) {
      const payload = JSON.stringify({ class: cls, sections }, null, 2);
      if (opts.json === true) process.stdout.write(payload + '\n');
      else {
        fs.writeFileSync(opts.json, payload);
        process.stdout.write(`Wrote ${opts.json}\n`);
      }
      return;
    }
    process.stdout.write(`\n${cls.name} — sections (${sections.length})\n`);
    for (const s of sections) {
      process.stdout.write(`  P15_ID=${s.p15Id}  ${s.name}\n`);
    }
    process.stdout.write('\n');
  });
}

async function cmdItems(opts) {
  const classCourseId = opts.class || opts._[1];
  const section = opts.section || opts._[2];
  if (!classCourseId || !section) {
    throw new Error('usage: items --class <classCourseId> --section <sectionP15Id>');
  }
  return withBrowser(async (context) => {
    const { items } = await oa.listItems(context, classCourseId, section);
    if (opts.json) {
      const payload = JSON.stringify({ items }, null, 2);
      if (opts.json === true) process.stdout.write(payload + '\n');
      else {
        fs.writeFileSync(opts.json, payload);
        process.stdout.write(`Wrote ${opts.json}\n`);
      }
      return;
    }
    process.stdout.write(`\nItems (${items.length})\n`);
    for (const it of items) {
      process.stdout.write(
        `  [${(it.status || '?').padEnd(11)}] ${it.type.padEnd(8)} P15_ID=${it.p15Id}  ${it.name}\n`
      );
    }
    process.stdout.write('\n');
  });
}

function lettersToIndices(str) {
  return String(str)
    .split(/[+,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      const c = s.charCodeAt(0);
      if (c < 97 || c > 122) throw new Error(`bad choice letter "${s}"`);
      return c - 97;
    });
}

function printQuiz(q) {
  process.stdout.write(`\n${q.heading || ''}\n${q.question}\n\n`);
  q.choices.forEach((c, i) => {
    process.stdout.write(`  ${String.fromCharCode(97 + i)}) ${c.text}${c.selected ? '  *' : ''}\n`);
  });
  process.stdout.write(`\n${q.multiple ? 'multi-select' : 'single choice'}\n`);
}

async function cmdQuiz(opts) {
  const sub = opts._[1];
  const arg = opts._[2];
  return withBrowser(async (context) => {
    const page = oa.findAppPage(context) || context.pages()[0];

    switch (sub) {
      case 'read': {
        const q = await oa.readQuiz(page);
        if (opts.json) {
          const payload = JSON.stringify(q, null, 2);
          if (opts.json === true) process.stdout.write(payload + '\n');
          else {
            fs.writeFileSync(opts.json, payload);
            process.stdout.write(`Wrote ${opts.json}\n`);
          }
          return;
        }
        printQuiz(q);
        return;
      }

      case 'answer': {
        if (!arg) throw new Error('usage: quiz answer <letters>   e.g. "b" or "a+c"');
        const indices = lettersToIndices(arg);
        await oa.clearChoices(page);
        await oa.selectChoices(page, indices);
        if (!opts['no-submit']) await oa.submitAnswer(page);
        const q = await oa.readQuiz(page);
        process.stdout.write(
          `${opts['no-submit'] ? 'Selected (not submitted)' : 'Submitted'} ${arg}\n`
        );
        printQuiz(q);
        return;
      }

      case 'complete': {
        await oa.completeAssessment(page);
        process.stdout.write(`Completed. Now at ${page.url().split('&cs=')[0]}\n`);
        return;
      }

      case 'start': {
        const classCourseId = opts.class;
        const section = opts.section;
        const item = opts.item;
        if (!classCourseId || !section || !item) {
          throw new Error('usage: quiz start --class <id> --section <sid> --item <iid>');
        }
        const it = await oa.findItemUrl(context, classCourseId, section, item);
        const p = await oa.startAssessment(context, it.url);
        process.stdout.write(`Assessment: ${it.name}\n${p.url().split('&cs=')[0]}\n`);
        printQuiz(await oa.readQuiz(p));
        return;
      }

      case 'run': {
        // Optionally start a quiz first.
        if (opts.class && opts.section && opts.item) {
          const it = await oa.findItemUrl(context, opts.class, opts.section, opts.item);
          await oa.startAssessment(context, it.url);
        }
        const res = await oa.runQuiz(context, {
          provider: opts.provider || 'gemini',
          model: opts.model,
          dryRun: !!opts['dry-run'],
          onProgress: (r) =>
            process.stdout.write(
              `Q${r.sequence}: ${r.letters.join('+')}  ${r.question.replace(/\s+/g, ' ').slice(0, 90)}\n`
            )
        });
        process.stdout.write(
          `\nAnswered ${res.results.length} question(s).\n${res.url.split('&cs=')[0]}\n`
        );
        return;
      }

      default:
        throw new Error(
          'usage: quiz read | answer <letters> | run [--provider gemini|openai] | complete | start --class <id> --section <sid> --item <iid>'
        );
    }
  });
}

async function cmdOpen(opts) {
  if (!opts.url) throw new Error('--url is required');
  const { browser, context } = await oa.ensureBrowser();
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    process.stdout.write(`Opened ${opts.url}\nThe browser stays open; reuse it with other commands.\n`);
  } finally {
    await oa.disconnect(browser);
  }
}

function sh(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit' });
}

async function cmdDoctor(opts) {
  const fix = !!opts.fix;
  const checks = [];
  const add = (name, ok, detail, remedy) => checks.push({ name, ok, detail, remedy });

  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('Node.js >= 18', major >= 18, process.version, 'brew install node');

  let pw;
  try {
    pw = oa.checkPlaywright();
  } catch (e) {
    pw = { playwright: false, chromium: false, reason: e.message };
  }
  add('Playwright package', !!pw.playwright, pw.playwright ? 'installed' : 'missing', 'npm install');
  add(
    'Chromium browser',
    !!pw.chromium,
    pw.executablePath && pw.chromium ? pw.executablePath : pw.reason || 'missing',
    'npx playwright install chromium'
  );

  const profile = oa.profileDir();
  add('Login profile', fs.existsSync(profile), profile, 'oracle-academy login');

  const running = await oa.debugReady();
  add('Shared browser', running, running ? `running on port ${oa.DEBUG_PORT}` : 'not running', 'oracle-academy login');

  try {
    const b = oa.detectDefaultBrowser(opts.browser);
    add('Default browser', true, `${b.name} (${b.bundle})`, '');
    const readable = oa.cookieStoreReadable(b);
    add(
      'Cookie store (Full Disk Access)',
      readable.ok,
      readable.ok ? b.dataDir : 'blocked by macOS',
      'System Settings > Privacy & Security > Full Disk Access -> enable your terminal'
    );
  } catch (err) {
    add('Default browser', false, err.message, 'oracle-academy login --browser brave');
  }

  process.stdout.write('\noracle-academy doctor\n---------------------\n');
  for (const c of checks) {
    process.stdout.write(`${c.ok ? '  \u2713' : '  \u2717'} ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}\n`);
    if (!c.ok && c.remedy) process.stdout.write(`      fix: ${c.remedy}\n`);
  }

  const missing = checks.filter((c) => !c.ok);
  process.stdout.write('\n');

  if (!missing.length) {
    process.stdout.write('All good. Next: oracle-academy whoami\n');
    return;
  }

  if (!fix) {
    process.stdout.write('Some checks failed. Re-run with --fix to install automatically:\n  oracle-academy doctor --fix\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Fixing...\n');
  if (!pw.playwright) sh('npm', ['install']);
  if (!pw.chromium) sh('npx', ['--yes', 'playwright', 'install', 'chromium']);
  process.stdout.write('\nDone. Re-run "oracle-academy doctor" to verify.\n');
  if (!fs.existsSync(profile)) process.stdout.write('Then run: oracle-academy login\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) {
    process.stdout.write(pkg.version + '\n');
    return;
  }
  const cmd = opts._[0];
  if (!cmd || opts.help) {
    process.stdout.write(HELP);
    return;
  }
  switch (cmd) {
    case 'login':
      return cmdLogin(opts);
    case 'cookies':
      return cmdCookies(opts);
    case 'whoami':
      return cmdWhoami(opts);
    case 'dump':
      return cmdDump(opts);
    case 'list':
      return cmdList(opts);
    case 'sections':
      return cmdSections(opts);
    case 'items':
      return cmdItems(opts);
    case 'quiz':
      return cmdQuiz(opts);
    case 'open':
      return cmdOpen(opts);
    case 'doctor':
      return cmdDoctor(opts);
    default:
      process.stderr.write(`Unknown command "${cmd}"\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
