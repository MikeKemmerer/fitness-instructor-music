import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Node's cwd for gh must be inside the repo; assume this is run from the repo root.
async function gh(args) {
  const { stdout } = await run('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function headSha() {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return stdout.trim();
}

async function findRun(workflow, sha, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stdout = await gh(['run', 'list', '--workflow', workflow, '--branch', 'master',
      '--json', 'databaseId,headSha,status,conclusion,url', '--limit', '10']);
    const match = JSON.parse(stdout).find(entry => entry.headSha === sha);
    if (match) return match;
    await sleep(3000);
  }
  throw new Error(`No ${workflow} run found for commit ${sha} after waiting.`);
}

async function waitForRun(databaseId, { onWaiting, pollMs = 15000, timeoutMs = 3 * 60 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announcedWaiting = false;
  for (;;) {
    const stdout = await gh(['run', 'view', String(databaseId), '--json', 'status,conclusion,url']);
    const info = JSON.parse(stdout);
    if (info.status === 'completed') return info;
    if (info.status === 'waiting' && onWaiting && !announcedWaiting) {
      onWaiting(info);
      announcedWaiting = true;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting on run ${databaseId} (last status: ${info.status}).`);
    }
    await sleep(pollMs);
  }
}

async function main() {
  const sha = process.argv[2] || await headSha();
  console.log(`Watching pipeline for commit ${sha.slice(0, 12)}...`);

  console.log('Locating Verify (CI) run...');
  const verify = await findRun('verify.yml', sha);
  console.log(`Verify run: ${verify.url}`);
  const verifyResult = await waitForRun(verify.databaseId);
  console.log(`Verify finished: ${verifyResult.conclusion}`);
  if (verifyResult.conclusion !== 'success') {
    console.error('CI failed. Stopping before deploy.');
    process.exitCode = 1;
    return;
  }

  console.log('Locating Deploy run...');
  const deploy = await findRun('deploy.yml', sha);
  console.log(`Deploy run: ${deploy.url}`);
  const deployResult = await waitForRun(deploy.databaseId, {
    onWaiting: info => console.log(
      `\n>>> Deploy is waiting for manual approval (production Environment gate).\n` +
      `>>> Approve at: ${info.url}\n` +
      `>>> This script will keep watching and will NOT approve it for you.\n`),
  });
  console.log(`Deploy finished: ${deployResult.conclusion}`);
  if (deployResult.conclusion !== 'success') {
    console.error('Deploy did not succeed. Not running post-deploy verification.');
    process.exitCode = 1;
    return;
  }

  console.log('Running post-deploy live verification (infra/verify-azure-live.mjs)...');
  try {
    const { stdout } = await run(process.execPath, ['infra/verify-azure-live.mjs'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    console.log(stdout);
    console.log('Pipeline complete: deploy succeeded and live verification passed.');
  } catch (error) {
    console.error('Post-deploy live verification failed:', error.stdout || error.message);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Pipeline watch stopped:', error.message);
  process.exitCode = 1;
});
