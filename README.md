# oracle-academy

A Node.js + Playwright CLI that signs in to **Oracle Academy** once via Oracle
SSO, keeps the session alive in a long-lived browser, and drives the Student Hub
(an Oracle APEX app) from the command line.

Once authenticated you can list your classes, browse sections and items, and take
quizzes/exams — either step by step or fully automatically with an LLM answer
engine.

- Reuses a single, already-signed-in browser (Oracle's APEX cookie is a session
  cookie, so the browser must stay open).
- Never stores or types your credentials. SSO is always completed by hand.
- Can import an existing session from your default browser, so you often don't
  need to sign in again at all.

## Requirements

- Node.js 18 or newer.
- An Oracle Academy account with Student Hub access.

## Install

```bash
npm install
npx playwright install chromium
```

Verify everything is wired up:

```bash
npx oracle-academy doctor
```

## Quick start

```bash
# 1. Sign in once. This opens the Student Hub; sign in, then press y.
npx oracle-academy login

# 2. Confirm the live session.
npx oracle-academy whoami

# 3. List your classes.
npx oracle-academy list
```

**Keep the browser window open.** All other commands attach to that same browser
over the Chrome DevTools Protocol and reuse the live session. Close it when
you're finished (the session ends with it).

### Reusing your default browser

If your default browser (Brave/Chrome/Edge/Arc/Firefox) is already signed in to
Oracle Academy, `login` can import that session instead of asking you to sign in
again:

```bash
npx oracle-academy login              # prompts for y once signed in
npx oracle-academy login --poll       # watches the cookie store automatically
npx oracle-academy login --browser brave
```

On macOS, reading a browser's cookie store requires **Full Disk Access** for the
app you run the command from (Terminal, iTerm, your editor). Without it, `login`
falls back to signing in inside the tool's own browser, which needs no special
permissions. Force that path with:

```bash
npx oracle-academy login --playwright
```

Diagnose cookie access with:

```bash
npx oracle-academy cookies
```

## Commands

| Command | What it does |
|---|---|
| `login` | Reuse your default browser's Oracle session (cookie import). |
| `login --playwright` | Sign in by hand in the Playwright browser instead. |
| `cookies` | Diagnose the default browser and its cookie store. |
| `whoami` | Report whether the signed-in browser session is alive. |
| `list` | List your classes (Student Hub → My Classes). |
| `sections --class <id>` | List a class's sections. |
| `items --class <id> --section <sid>` | List a section's items (slides, guides, practices, quizzes). |
| `quiz read` | Read the current question and its choices. |
| `quiz answer <letters>` | Select choices (`a`, `b`, `a+c` for multi) and submit. |
| `quiz start --class <id> --section <sid> --item <iid>` | Open a quiz and begin the attempt. |
| `quiz run [--provider …]` | Auto-answer every question and complete the assessment. |
| `quiz complete` | Complete the assessment attempt. |
| `dump [--url <url>]` | Print a page's structure as text or JSON. |
| `open --url <url>` | Open a page in the shared browser and keep it open. |
| `doctor [--fix]` | Check Node, Playwright, Chromium, and login. |

Use `npx oracle-academy` (or the global `oracle-academy` after `npm i -g`) for
all commands. The examples below use `oracle-academy` for brevity.

## Student Hub

The Student Hub is Oracle APEX app **63000**. Pages carry a session id plus a
per-request checksum, so the tool navigates via links on the current page rather
than rebuilding URLs.

| Page | What |
|---|---|
| 1 | Home (nav to My Classes / Student Tools) |
| 100 | My Classes (class cards → page 14) |
| 14 | Take Class (`P14_ID` = class-course id, `P14_COURSE_ID` = course id) |
| 15 | Section / item list (`P15_ID`) |
| 190 | Take the Assessment (`P190_ID`, `P190_CLASS_COURSE_ID`, `P190_PREVIEW_ONLY`) |

```bash
oracle-academy list
oracle-academy sections --class <classCourseId>
oracle-academy items --class <classCourseId> --section <sectionId>
```

### Quizzes

Step by step (agent- or human-supplied answers):

```bash
oracle-academy quiz start --class <classCourseId> --section <sectionId> --item <itemId>
oracle-academy quiz read
oracle-academy quiz answer b          # "a+c" for multi-select; --no-submit to preview
oracle-academy quiz complete
```

Fully automatic (an LLM answers each question):

```bash
export GEMINI_API_KEY=...             # or OPENAI_API_KEY / OPENAI_BASE_URL
oracle-academy quiz run --class <classCourseId> --section <sectionId> --item <itemId>
```

Answer engines live in `src/providers/`:

| Provider | Env | Notes |
|---|---|---|
| `gemini` (default) | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `ORACLE_QUIZ_GEMINI_MODEL` (default `gemini-2.5-flash`) |
| `openai` | `OPENAI_API_KEY` / `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint, incl. local Ollama |

## Docker

No local Node, browser, or permissions needed — everything runs in a container.
Oracle's edge blocks headless Chromium and login is manual SSO, so the login
browser runs on a virtual display you view through **noVNC**.

```bash
docker compose up -d --build          # or: ./oracle list  (starts it automatically)
```

Then:

1. Open the login browser: **http://localhost:6080/vnc.html**
2. Sign in to Oracle Academy inside that page.
3. From your terminal, confirm:
   ```bash
   ./oracle login
   ```
4. Put an answer-engine key in `.env` (see `.env.example`), then run it:
   ```bash
   cp .env.example .env                # add GEMINI_API_KEY=...
   ./oracle list
   ./oracle sections --class <classCourseId>
   ./oracle quiz run --class <classCourseId> --section <sectionId> --item <itemId>
   ```

`./oracle` is a thin wrapper around `docker compose exec app oracle-academy …`.
The browser profile lives in the `oracle-data` volume, so it survives container
restarts — but the live session still needs the browser to stay running, so keep
the container up.

## Configuration

| Variable | Purpose |
|---|---|
| `ORACLE_ACADEMY_PROFILE` | Browser profile directory (default `~/.oracle-academy/profile`). |
| `ORACLE_ACADEMY_HUB_URL` | Hub URL opened for login (default Student Hub `p=63000`). |
| `ORACLE_ACADEMY_HOME_URL` | Public home URL. |
| `ORACLE_ACADEMY_DEBUG_PORT` | CDP port for the shared browser (default `9333`). |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini answer engine. |
| `ORACLE_QUIZ_GEMINI_MODEL` | Gemini model override. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible answer engine. |
| `ORACLE_QUIZ_OPENAI_MODEL` | OpenAI model override. |

## Library

`oracle-academy` also works as a library:

```js
const oa = require('oracle-academy');

const ctx = await oa.launch({ headless: true });
try {
  if (!(await oa.isLoggedIn(ctx))) throw new Error('run: oracle-academy login');
  const dump = await oa.dumpPage(ctx, oa.HUB_URL);
  console.log(dump.apex, dump.headings.length, 'headings');
} finally {
  await ctx.close();
}
```

Exports include: `launch`, `ensureBrowser`, `disconnect`, `isLoggedIn`,
`sessionStatus`, `profileDir`, `login`, `loginInteractive`,
`loginWithDefaultBrowser`, `detectDefaultBrowser`, `cookieStoreReadable`,
`readCookies`, `importCookies`, `openInDefaultBrowser`, `dumpPage`, `apexLinks`,
`listClasses`, `listSections`, `listItems`, `findItemUrl`, `readQuiz`,
`selectChoices`, `submitAnswer`, `completeAssessment`, `startAssessment`,
`runQuiz`, `getAnswerProvider`, `HUB_URL`, `STUDENT_HUB_URL`, `MEMBER_HUB_URL`.

## How it works

Oracle Academy protects its pages with Oracle IDCS SSO: any protected URL
redirects to `https://signon.oracle.com/signin`. The tool opens that flow in a
persistent Chromium profile, waits for the redirect back to `academy.oracle.com`,
and stores the session locally.

Because the APEX session cookie is a *session* cookie, the tool keeps **one
browser running** (spawned detached with `--remote-debugging-port`, attached over
CDP). Every command attaches, does its work, and disconnects **without closing**
the browser, preserving the live session for later commands.

Oracle's Akamai edge blocks headless Chromium (it serves a "Technical Issue"
page), so commands run **headed** by default; `--headless` is opt-in and usually
fails.

## Notes

- The saved session expires eventually; re-run `login` when `whoami` reports
  signed out.
- Intended for your own Oracle Academy account and normal use. SSO is completed
  by hand and no credentials are stored by the tool.

## License

MIT
