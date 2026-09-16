import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredHostedCaseNames, requiredHostedTests } from './report-policy.mjs';

function fixture() {
  return { success: true, numFailedTests: 0, numPassedTests: 15, numPendingTests: 4, testResults: [
    { name: '/workspace/tests/hosted-browser.test.ts', assertionResults: requiredHostedCaseNames.map(title => ({ title, status: 'passed' })) },
    { name: '/workspace/tests/loudness.test.ts', assertionResults: ['02', '06', '11', '12'].map(index => ({
      title: `compares authorized private file index ${index} through the actual stored AAC pipeline`, status: 'pending' })) },
  ] };
}

test('accepts only the four explicit opt-in private comparisons', () => {
  assert.equal(requiredHostedTests(fixture()).passed, 15);
});

test('rejects unrelated skips, failures, missing results and duplicate optional cases', () => {
  for (const mutate of [
    report => { report.testResults[0].assertionResults[0].status = 'pending'; },
    report => { report.testResults[0].assertionResults[0].status = 'failed'; },
    report => { report.testResults[0].assertionResults.pop(); report.numPassedTests--; },
    report => { report.testResults[0].assertionResults[0].title = 'Requires frontend/dist built with VITE_HOSTED_PILOT=true'; },
    report => { report.testResults[0].assertionResults[0].title = 'unrelated replacement case'; },
    report => { report.testResults[0].assertionResults[0].title = report.testResults[0].assertionResults[1].title; },
    report => { report.testResults[1].name = '/workspace/tests/other.test.ts'; },
    report => { report.numFailedTests = 1; },
    report => { report.success = false; },
    report => { report.testResults[1].assertionResults[0].title = 'another test'; },
    report => { report.testResults[1].assertionResults[0].title = report.testResults[1].assertionResults[1].title; },
    report => { report.numPassedTests++; },
    report => { report.numPendingTests++; },
  ]) {
    const report = fixture();
    mutate(report);
    assert.throws(() => requiredHostedTests(report));
  }
});