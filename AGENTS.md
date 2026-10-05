# oracle-academy — agent guide

**oracle-academy** is a Node/Playwright CLI that logs into Oracle Academy
(Student Hub, an Oracle APEX app) via Oracle SSO, keeps the session in a
long-lived browser, and drives the app with it.

## Setup

```bash
npm install
npx playwright install chromium
oracle-academy doctor --fix      # verify Node, Playwright, Chromium, cookie access
oracle-academy login             # reuses the default browser's Oracle session
```

`login` (default) reuses the **default browser's** session: it opens the Student
Hub there, waits while the user signs in, and imports that browser's Oracle
cookies when the user **presses `y`** (`src/default-browser.js` +
`loginWithDefaultBrowser`). `--poll` watches cookies automatically instead of
prompting. macOS protects **browser** cookie stores with **Full Disk Access**;
when reading is blocked, `login` falls back to signing in in the tool's browser
(`loginInteractive`, same `y` prompt). `oracle-academy cookies` diagnoses the store.

**Session model:** Oracle Academy's APEX cookie (`ORA_WWV_APP_63000`) is a *session*
cookie, so it's lost when the browser closes and the server then rejects it.
Therefore the tool keeps **one browser running** (`ensureBrowser` in
`src/browser.js`: spawn detached with `--remote-debugging-port` and attach over
CDP). Every command attaches, does its work, and disconnects **without closing**
the browser. Never `browser.close()` the shared browser expecting to keep the
session; use `disconnect`. Tell the user to keep the window open.

**Never type credentials for the user** — SSO is always manual. In the browser the
flow is username → Next → password → Sign In (MFA if prompted).

Two APEX hubs: **63000 = Student Hub** (student course links, the default) and
**62000 = Member Hub** (educators/institutions).

Oracle's Akamai edge blocks headless Chromium (serves a "Technical Issue" page),
so commands run **headed** by default; `--headless` is opt-in and usually fails.

## The Student Hub

APEX app **63000**: page **1** Home, **100** My Classes, **14** Take Class
(`P14_ID` class-course id, `P14_COURSE_ID` course id), **190** course item
(`P190_ID`, `P190_CLASS_COURSE_ID`, `P190_PREVIEW_ONLY`). Pages carry the session
id + a checksum, so navigate via links on the current page, never rebuilt URLs.
`src/hub.js` implements this; `listClasses` powers `oracle-academy list`.

Page **15** is a section (lists items: lesson slides, student guides, practices,
quizzes/exams) and page **190** is the assessment. `src/quiz.js` drives it.

```bash
oracle-academy whoami
oracle-academy list [--json /tmp/classes.json]
oracle-academy sections --class <classCourseId>
oracle-academy items --class <classCourseId> --section <sectionId>
oracle-academy quiz start --class <classCourseId> --section <sectionId> --item <itemId>
oracle-academy quiz run --class <classCourseId> --section <sectionId> --item <itemId>   # auto-answer + complete
oracle-academy quiz read            # question + choices (a,b,c...)
oracle-academy quiz answer b        # "a+c" for multi; --no-submit to preview
oracle-academy quiz complete
oracle-academy dump [--json /tmp/page.json]    # dumps the open app page
```

`quiz run` answers each question with an LLM provider (`src/providers/`):
`gemini` (GEMINI_API_KEY/GOOGLE_API_KEY) or `openai` (OPENAI_API_KEY +
OPENAI_BASE_URL for local models). Providers return option letters for the
current question (`answerOne`). Without a key, drive it with `quiz read` +
`quiz answer`.

Quiz DOM (page 190): `#question-Text`, `.choice-Container button.choice-SelectArea`,
`#quiz-submit`, `button[data-otel-label=CONFIRMCOMPLETE]`.

`dump` with no `--url` dumps the signed-in page already open (navigating to a
bare hub URL starts a new session and bounces to SSO).

Read `/tmp/hub.json`: `apex` gives `{app, page}`, and `links`/`headings`/`buttons`
describe navigation. Map the real structure before adding purpose-built commands.

## Adding commands

- `src/browser.js` — persistent context, Oracle URLs, sign-in detection.
- `src/auth.js` — SSO wait/login + default-browser cookie-import login.
- `src/default-browser.js` — detect default browser, read/decrypt/import cookies.
- `src/explore.js` — page → JSON discovery.
- `src/index.js` — public library surface.
- `bin/oracle-academy.js` — CLI (`login`, `cookies`, `whoami`, `dump`, `open`, `doctor`).

## Container

`Dockerfile` + `docker-compose.yml` + `oracle` wrapper. The container runs the
Playwright browser on a virtual display (`Xvfb`) exposed via `x11vnc` + `noVNC`
because Oracle's edge blocks headless and login is manual SSO.

```bash
docker compose up -d --build        # noVNC: http://localhost:6080/vnc.html
./oracle login                      # then sign in via the VNC page, press y
./oracle list
```

`oracle` wraps `docker compose exec app oracle-academy …`. Profile lives in the
`oracle-data` volume. The Playwright base image tag must match the `playwright`
version in `package.json` (`v1.63.0-jammy`). Browser runs as root, so
`spawnBrowser` passes `--no-sandbox --disable-dev-shm-usage`.

## Rules

- For the user's own Oracle Academy account and normal use.
- SSO is completed by hand; the tool stores only the browser profile.
- Confirm which page/app a command targets (check `apex.app`/`apex.page`) before
  acting on it — a wrong APEX URL can load a different page.
