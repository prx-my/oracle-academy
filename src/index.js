'use strict';

// Public library surface for integrating oracle-academy into your own tooling.
//
//   const oa = require('oracle-academy');
//   const ctx = await oa.launch({ headless: true });
//   const dump = await oa.dumpPage(ctx, oa.HUB_URL);
//   await ctx.close();

const browser = require('./browser');
const auth = require('./auth');
const explore = require('./explore');
const hub = require('./hub');
const quiz = require('./quiz');
const providers = require('./providers');
const defaultBrowser = require('./default-browser');

module.exports = {
  // browser / session
  launch: browser.launch,
  ensureBrowser: browser.ensureBrowser,
  disconnect: browser.disconnect,
  debugReady: browser.debugReady,
  DEBUG_PORT: browser.DEBUG_PORT,
  findAppPage: browser.findAppPage,
  isLoggedIn: browser.isLoggedIn,
  sessionStatus: browser.sessionStatus,
  profileDir: browser.profileDir,
  checkPlaywright: browser.checkPlaywright,
  HOME_URL: browser.HOME_URL,
  HUB_URL: browser.HUB_URL,
  MEMBER_HUB_URL: browser.MEMBER_HUB_URL,
  STUDENT_HUB_URL: browser.STUDENT_HUB_URL,
  isSignonUrl: browser.isSignonUrl,
  isAcademyUrl: browser.isAcademyUrl,
  isBlockedPage: browser.isBlockedPage,

  // auth
  login: auth.login,
  loginInteractive: auth.loginInteractive,
  waitForSignIn: auth.waitForSignIn,
  loginWithDefaultBrowser: auth.loginWithDefaultBrowser,

  // default browser session reuse
  detectDefaultBrowser: defaultBrowser.detectDefaultBrowser,
  cookieStoreReadable: defaultBrowser.cookieStoreReadable,
  readCookies: defaultBrowser.readCookies,
  importCookies: defaultBrowser.importCookies,
  openInDefaultBrowser: defaultBrowser.openInDefaultBrowser,
  FDA_HINT: defaultBrowser.FDA_HINT,

  // discovery
  dumpPage: explore.dumpPage,
  apexLinks: explore.apexLinks,

  // student hub
  listClasses: hub.listClasses,
  openMyClasses: hub.openMyClasses,
  openClass: hub.openClass,
  listSections: hub.listSections,
  openSection: hub.openSection,
  listItems: hub.listItems,
  findItemUrl: hub.findItemUrl,

  // assessment
  readQuiz: quiz.readQuiz,
  selectChoices: quiz.selectChoices,
  clearChoices: quiz.clearChoices,
  submitAnswer: quiz.submitAnswer,
  completeAssessment: quiz.completeAssessment,
  startAssessment: quiz.startAssessment,
  runQuiz: quiz.runQuiz,
  lettersToIndices: quiz.lettersToIndices,
  isAssessmentPage: quiz.isAssessmentPage,

  // answer providers
  getAnswerProvider: providers.getAnswerProvider
};
