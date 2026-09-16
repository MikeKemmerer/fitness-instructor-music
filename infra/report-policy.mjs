import assert from 'node:assert/strict';

export const requiredHostedCaseNames = Object.freeze([
  'imports synthetic Ogg Opus through the production bundle and CSP (1 channels, 0 comment bytes)',
  'imports synthetic Ogg Opus through the production bundle and CSP (2 channels, 0 comment bytes)',
  'imports synthetic Ogg Opus through the production bundle and CSP (1 channels, 70000 comment bytes)',
  'imports synthetic Ogg Opus through the production bundle and CSP (2 channels, 2097152 comment bytes)',
  'custom form rejects wrong credentials, authenticates with secure cookies, and fits desktop/mobile',
  'same stable ID relogin preserves local routines and all PCM audio',
  'explicit logout purges private records, preferences, caches and a playing second tab',
  'real account switch purges old records before the new account enters',
  'expiry and refresh 401 preserve real audio timers/cues; admitted reload restores the cached cloud routine and media offline',
  'household Practice cue Save keeps the current prepared revision paused without autoplay or media downloads',
  'class authors prepare cold drafts and players restore exact published setups after source republish offline',
  'real PCM upload/publish/download reaches a player-only Edit selection view without author controls or private writes',
  'cold Prepare preserves playing audio on failure, then a fresh local draft reuses the archived exact ID without filler allocation',
  'UserFiller shares across authors, uses two-tap downloaded preview and remains published/playable after archive',
  'session invalidation cancels a pending actual PDF before its delayed font response resolves',
]);

export function requiredHostedTests(report) {
  assert.equal(report.success, true, 'Hosted tests failed.');
  assert.equal(report.numFailedTests, 0, 'Hosted test failures.');
  const expected = ['02', '06', '11', '12'].map(index =>
    `compares authorized private file index ${index} through the actual stored AAC pipeline`);
  const optional = [];
  let executed = 0;
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status === 'passed') { executed++; continue; }
      assert(['pending', 'skipped'].includes(test.status), 'Unsuccessful required test.');
      assert(file.name.replaceAll('\\', '/').endsWith('/tests/loudness.test.ts'), 'Required test skipped.');
      assert(expected.includes(test.title), 'Unapproved optional test.');
      optional.push(test.title);
    }
  }
  assert.equal(executed, report.numPassedTests, 'Incomplete test report.');
  assert.equal(report.numPendingTests, 4, 'Unexpected skipped count.');
  assert.deepEqual(optional.sort(), expected.sort(), 'Missing or duplicate optional cases.');
  const browser = report.testResults.find(file => file.name.replaceAll('\\', '/').endsWith('/tests/hosted-browser.test.ts'));
  assert(browser, 'Hosted browser coverage missing.');
  const names = browser.assertionResults.map(test => test.title);
  assert.equal(new Set(names).size, names.length, 'Duplicate hosted browser case.');
  assert(!names.includes('Requires frontend/dist built with VITE_HOSTED_PILOT=true'), 'Local-only build sentinel in hosted results.');
  assert(requiredHostedCaseNames.every(name => names.includes(name)), 'Required hosted browser coverage missing.');
  assert(browser.assertionResults.every(test => test.status === 'passed'), 'Hosted browser case did not pass.');
  return { passed: executed, skipped: optional.length, optionalPrivateTests: optional, hostedBrowser: browser.assertionResults.length };
}