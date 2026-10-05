'use strict';

// Oracle Academy assessment automation (APEX app 63000, page 190).
//
// A quiz is reached from a section (page 15): navigating to the quiz item shows
// an "Assessment Card" with a Start dialog; confirming it opens page 190
// ("Take the Assessment"), where each question is rendered with choice buttons
// and a "Submit Answer" action. After the last question, "Complete Assessment"
// finalises the attempt.
//
// DOM landmarks (page 190):
//   #question-Text                      question text (+ heading "Question N of M")
//   .choice-Container                   one per choice
//     button.choice-SelectArea          click to select/deselect
//     span.choice-Text                  choice text
//     span.choice-Icon                  fa-square-o / fa-check-square-o
//   #quiz-submit                        submit the current answer
//   button[data-otel-label=CONFIRMCOMPLETE]   complete the attempt
//   button[data-otel-label=PREVIOUS]    previous question
//   hidden inputs P190_*                question/answer state

const { findAppPage } = require('./browser');
const { getAnswerProvider } = require('./providers');

const SUBMIT_SEL = '#quiz-submit';
const COMPLETE_SEL = 'button[data-otel-label="CONFIRMCOMPLETE"]';
const PREVIOUS_SEL = 'button[data-otel-label="PREVIOUS"]';

function val(script) {
  return script;
}

/** Read the current question and its choices. */
async function readQuiz(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const hidden = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : null;
    };

    const heading = clean(document.querySelector('#question-Text_heading')?.textContent);
    let question = clean(document.querySelector('#question-Text')?.textContent);
    if (heading && question.startsWith(heading)) question = question.slice(heading.length).trim();

    const choices = [...document.querySelectorAll('.choice-Container')].map((c, i) => {
      const icon = c.querySelector('.choice-Icon');
      const cls = icon ? icon.className : '';
      return {
        index: i,
        text: clean(c.querySelector('.choice-Text')?.textContent),
        selected: /fa-check|fa-dot|is-selected|fa-check-square/.test(cls)
      };
    });

    return {
      heading,
      question,
      choices,
      multiple: hidden('P190_ONLY_ONE_CHOICE') !== 'Y',
      sequence: hidden('P190_QUESTION_SEQUENCE'),
      count: hidden('P190_QUESTION_COUNT'),
      allAnswered: hidden('P190_ALL_ANSWERED'),
      answered: hidden('P190_CHOICE_CLICKED')
    };
  });
}

/** Click choice buttons by zero-based index (toggles; for single-choice the UI clears others). */
async function selectChoices(page, indices) {
  const buttons = page.locator('.choice-Container button.choice-SelectArea');
  const total = await buttons.count();
  for (const i of indices) {
    if (i < 0 || i >= total) throw new Error(`choice ${i} out of range (0..${total - 1})`);
    await buttons.nth(i).click();
    await page.waitForTimeout(300);
  }
}

/** Clear any selected choices. */
async function clearChoices(page) {
  const state = await readQuiz(page);
  const selected = state.choices.filter((c) => c.selected).map((c) => c.index);
  if (selected.length) await selectChoices(page, selected);
}

/** Submit the current answer and wait for the next question (or completion). */
async function submitAnswer(page) {
  await page.click(SUBMIT_SEL);
  await page.waitForTimeout(3000);
}

/** Complete the assessment attempt (clicks the confirmation button). */
async function completeAssessment(page) {
  await page.click(COMPLETE_SEL);
  await page.waitForTimeout(2500);
}

/** True when the current page is the assessment (page 190). */
function isAssessmentPage(page) {
  return /p=63000:190:/.test(page.url());
}

/**
 * From a section item (page 15 quiz card), open and start the assessment.
 * Returns the assessment page once page 190 is reached.
 */
async function startAssessment(context, quizUrl) {
  const page = findAppPage(context) || context.pages()[0] || (await context.newPage());
  await page.goto(quizUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  if (isAssessmentPage(page)) return page;

  // The quiz card exposes an "open assessment" trigger that navigates to page 190.
  const trigger = page.locator('#open_assess_id');
  if (await trigger.count()) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      trigger.click()
    ]);
    await page.waitForTimeout(4000);
  }
  if (!isAssessmentPage(page)) {
    // Fall back to the Start dialog if present.
    const start = page.locator('button[data-otel-label="START"]');
    if (await start.count()) {
      await start.click().catch(() => {});
      await page.waitForTimeout(4000);
    }
  }
  return page;
}

function lettersToIndices(letters) {
  return letters.map((l) => {
    const c = String(l).charCodeAt(0);
    if (c < 97 || c > 122) throw new Error(`bad choice letter "${l}"`);
    return c - 97;
  });
}

/**
 * Answer every question in the open assessment and complete it.
 *
 * @param {object} context
 * @param {object} opts { provider?, model?, answers?, dryRun?, delayMs?, maxQuestions?, onProgress? }
 *   answers: optional array of letter-arrays to supply answers directly (agent-driven).
 */
async function runQuiz(context, opts = {}) {
  const page = findAppPage(context);
  if (!page || !isAssessmentPage(page)) {
    throw new Error('Not on an assessment page. Run "oracle-academy quiz start ..." first.');
  }

  const provider = getAnswerProvider(opts.provider || 'gemini');
  if (!provider && !opts.answers) {
    throw new Error('Provider "none" needs answers supplied by the caller.');
  }

  const results = [];
  const max = opts.maxQuestions || 200;
  for (let i = 0; i < max; i++) {
    const q = await readQuiz(page);
    if (!q.question || !q.choices.length) break;

    let letters;
    if (opts.answers && opts.answers[i]) {
      letters = opts.answers[i];
    } else {
      letters = await provider.answerOne({
        question: q.question,
        choices: q.choices.map((c) => c.text),
        multiple: q.multiple,
        model: opts.model
      });
    }

    await clearChoices(page);
    await selectChoices(page, lettersToIndices(letters));
    if (!opts.dryRun) await submitAnswer(page);

    results.push({ sequence: q.sequence, question: q.question, letters });
    if (opts.onProgress) opts.onProgress(results[results.length - 1]);

    if (String(q.sequence) === String(q.count)) break;
    if (opts.delayMs) await page.waitForTimeout(opts.delayMs);
  }

  if (!opts.dryRun) await completeAssessment(page);
  return { results, url: page.url() };
}

module.exports = {
  readQuiz,
  selectChoices,
  clearChoices,
  submitAnswer,
  completeAssessment,
  startAssessment,
  runQuiz,
  lettersToIndices,
  isAssessmentPage,
  SUBMIT_SEL,
  COMPLETE_SEL,
  PREVIOUS_SEL
};
