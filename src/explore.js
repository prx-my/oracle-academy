'use strict';

// Page discovery: turn a rendered Oracle Academy page into structured JSON.
//
// Oracle Academy is an Oracle APEX app, so navigation is driven by links like
// /pls/f?p=<app>:<page>:<session>:::<page>:<items>:<values>. Dumping headings,
// links, buttons and forms is how we map the Member Hub before writing
// purpose-built commands (list courses, open a class, etc.).

const { HUB_URL, isBlockedPage, findAppPage } = require('./browser');

const DEFAULT_WAIT_MS = 2000;

async function dumpPage(context, url, opts = {}) {
  // Without an explicit URL, dump the signed-in app page that's already open
  // (navigating to a bare hub URL would start a new session and bounce to SSO).
  const page = url
    ? context.pages()[0] || (await context.newPage())
    : findAppPage(context) || context.pages()[0] || (await context.newPage());
  if (url) await page.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded' });
  await page.waitForTimeout(opts.waitMs != null ? opts.waitMs : DEFAULT_WAIT_MS);

  const data = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const headings = [...document.querySelectorAll('h1,h2,h3,h4')]
      .map((h) => ({ level: h.tagName.toLowerCase(), text: clean(h.textContent) }))
      .filter((h) => h.text);

    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => ({
        text: clean(a.textContent) || clean(a.getAttribute('aria-label')) || clean(a.title),
        href: a.href
      }))
      .filter((l) => l.href);

    const buttons = [
      ...document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]')
    ]
      .map((b) => clean(b.textContent || b.value || b.getAttribute('aria-label')))
      .filter(Boolean);

    const forms = [...document.querySelectorAll('form')].map((f) => ({
      action: f.getAttribute('action') || '',
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: [...f.querySelectorAll('input,select,textarea')].map((el) => ({
        name: el.name || '',
        type: el.type || el.tagName.toLowerCase()
      }))
    }));

    // APEX pages expose the app/page id in the URL; surface it for mapping.
    const apex = (() => {
      const m = location.href.match(/[?&]p=(\d+):(\d+)/);
      return m ? { app: m[1], page: m[2] } : null;
    })();

    return {
      title: document.title,
      url: location.href,
      apex,
      blocked: false,
      headings,
      links,
      buttons,
      forms
    };
  });

  data.blocked = isBlockedPage(data.title) || isBlockedPage(data.headings.map((h) => h.text).join(' '));
  return data;
}

/** Filter a dump down to the links that look like APEX page targets. */
function apexLinks(dump) {
  return (dump.links || []).filter((l) => /\/pls\/f\?p=\d+/.test(l.href));
}

module.exports = { dumpPage, apexLinks, DEFAULT_WAIT_MS, HUB_URL };
