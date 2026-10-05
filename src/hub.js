'use strict';

// Student Hub navigation + scraping.
//
// Page map (APEX app 63000):
//   1   Home          – nav links to My Classes / Student Tools
//   100 My Classes    – class cards, each linking to page 14
//   14  Take Class    – P14_ID (class-course id), P14_COURSE_ID (course id)
//   190 course item   – P190_ID, P190_CLASS_COURSE_ID, P190_PREVIEW_ONLY
//
// Pages carry the session id in the URL and a per-request checksum, so we always
// navigate via links found on the current page rather than rebuilding URLs.

const { findAppPage } = require('./browser');

const CLASS_ACTION_RE = /p=63000:14:/;

async function findLinkHref(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    for (const a of document.querySelectorAll('a[href]')) {
      if (rx.test(a.textContent || '') && !/^javascript:/i.test(a.href)) return a.href;
    }
    return null;
  }, re.source);
}

async function findHrefByPattern(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    for (const a of document.querySelectorAll('a[href]')) {
      if (rx.test(a.getAttribute('href') || a.href)) return a.href;
    }
    return null;
  }, re.source);
}

/** Navigate to the My Classes page (100), going via Home if needed. */
async function openMyClasses(context) {
  const page = findAppPage(context) || context.pages()[0] || (await context.newPage());

  let link = await findLinkHref(page, /My Classes/);
  if (!link) {
    const home = (await findLinkHref(page, /^Home$/)) || (await findHrefByPattern(page, /p=63000:1:/));
    if (home) {
      await page.goto(home, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }
    link = await findLinkHref(page, /My Classes/);
  }
  if (!link) throw new Error('Could not find the "My Classes" link. Are you signed in?');

  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return page;
}

/** Extract class cards from the current page. */
async function readClasses(page) {
  return page.evaluate((actionReSrc) => {
    const actionRe = new RegExp(actionReSrc, 'i');
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const parseItems = (href) => {
      // ...:::14:P14_ID,P14_COURSE_ID:<classCourseId>,<courseId>&cs=...
      const m = href.match(/:::(\d+):([^:&]*):([^&]*)/);
      if (!m) return {};
      const names = (m[2] || '').split(',');
      const values = (m[3] || '').split(',');
      const items = {};
      names.forEach((n, i) => {
        if (n) items[n] = values[i];
      });
      return items;
    };

    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (!actionRe.test(href)) continue;
      let el = a;
      let card = null;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (el && el.querySelector('h3')) {
          card = el;
          break;
        }
      }
      const h3 = card && card.querySelector('h3');
      const h4 = card && card.querySelector('h4');
      const items = parseItems(href);
      out.push({
        name: clean(h3 && h3.textContent),
        meta: clean(h4 && h4.textContent),
        classCourseId: items.P14_ID || null,
        courseId: items.P14_COURSE_ID || null,
        action: clean(a.textContent),
        url: href
      });
    }
    return out;
  }, CLASS_ACTION_RE.source);
}

/** List the signed-in student's classes. */
async function listClasses(context) {
  const page = await openMyClasses(context);
  const classes = await readClasses(page);
  return { url: page.url(), classes };
}

/** Open a class's outline (page 14) by class-course id. */
async function openClass(context, classCourseId) {
  const { classes } = await listClasses(context);
  const target =
    classes.find((c) => c.classCourseId === String(classCourseId)) || classes[0];
  if (!target) throw new Error('No classes found');
  const page = findAppPage(context) || context.pages()[0];
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  return { page, cls: target };
}

const NAV_LABEL_RE =
  /^(skip to main content|home|help|language|student|my profile|sign out|sign in|search|menu)$/i;

// Read the course-outline links from page 14. Header/nav links can briefly carry
// the same P15_ID,P15_COURSE_ID,P15_CLASS_COURSE_ID params, so callers must wait
// for real section links (unique ids, non-nav labels) before trusting them.
function readSectionLinks(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (!/FROM_COURSE_OUTLINE/.test(href)) continue;
      const m = href.match(/P15_ID,P15_COURSE_ID,P15_CLASS_COURSE_ID:(\d+),(\d+),(\d+)/);
      if (!m) continue;
      out.push({
        name: clean(a.textContent).replace(/\s*\d+%\s*$/, '').trim(),
        p15Id: m[1],
        courseId: m[2],
        classCourseId: m[3],
        url: href
      });
    }
    return out;
  });
}

async function waitForSections(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let sections = [];
  do {
    const seen = new Set();
    sections = (await readSectionLinks(page)).filter((s) => {
      if (!s.name || NAV_LABEL_RE.test(s.name)) return false;
      if (seen.has(s.p15Id)) return false;
      seen.add(s.p15Id);
      return true;
    });
    if (sections.length) break;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return sections;
}

/** List the sections of a class (page 14 -> page 15 links). */
async function listSections(context, classCourseId) {
  const { page, cls } = await openClass(context, classCourseId);
  const sections = await waitForSections(page);
  return { cls, sections };
}

/** Open a section (page 15) inside a class. */
async function openSection(context, classCourseId, sectionP15Id) {
  const { page } = await openClass(context, classCourseId);
  const deadline = Date.now() + 15000;
  let href = null;
  do {
    href = await page.evaluate((sid) => {
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.href || '';
        if (!/FROM_COURSE_OUTLINE/.test(h)) continue;
        const m = h.match(/P15_ID,P15_COURSE_ID,P15_CLASS_COURSE_ID:(\d+),/);
        if (m && m[1] === sid) return h;
      }
      return null;
    }, String(sectionP15Id));
    if (href) break;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  if (!href) throw new Error(`Section ${sectionP15Id} not found`);
  await page.goto(href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  return page;
}

function classify(name) {
  if (/lesson slides/i.test(name)) return 'slides';
  if (/student guide/i.test(name)) return 'guide';
  if (/practice/i.test(name)) return 'practice';
  if (/quiz/i.test(name)) return 'quiz';
  if (/exam/i.test(name)) return 'exam';
  return 'item';
}

/** List the items (slides, guides, practices, quizzes) of a section. */
async function listItems(context, classCourseId, sectionP15Id) {
  const page = await openSection(context, classCourseId, sectionP15Id);
  const items = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const m = a.href.match(/p=63000:15:[^:]*:.*:::P15_ID,P15_COURSE_ID:(\d+),(\d+)/);
      if (!m) continue;
      let name = clean(a.textContent);
      const sm = name.match(/\((Completed|Active|Not Started|In Progress)\)/i);
      const status = sm ? sm[1] : null;
      name = name.replace(/\s*\((Completed|Active|Not Started|In Progress)\)\s*/i, '').trim();
      out.push({ name, status, p15Id: m[1], courseId: m[2], url: a.href });
    }
    return out;
  });
  return { url: page.url(), items: items.map((x) => ({ ...x, type: classify(x.name) })) };
}

/** Find a section item's URL by its P15 id. */
async function findItemUrl(context, classCourseId, sectionP15Id, itemP15Id) {
  const { items } = await listItems(context, classCourseId, sectionP15Id);
  const item = items.find((i) => i.p15Id === String(itemP15Id));
  if (!item) throw new Error(`Item ${itemP15Id} not found in section ${sectionP15Id}`);
  return item;
}

module.exports = {
  openMyClasses,
  readClasses,
  listClasses,
  openClass,
  listSections,
  openSection,
  listItems,
  findItemUrl,
  CLASS_ACTION_RE
};
