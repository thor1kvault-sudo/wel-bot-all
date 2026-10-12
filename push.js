#!/usr/bin/env node
/**
 * push.js — Auto-commit and push all changes to GitHub
 * Usage: node push.js [optional commit message]
 *        npm run push
 *        npm run push -- "your custom message"
 *
 * Reads GITHUB_PAT and GITHUB_USER from .env for silent authentication.
 */

require('dotenv').config();
const { execSync } = require('child_process');

const GITHUB_PAT  = process.env.GITHUB_PAT;
const GITHUB_USER = process.env.GITHUB_USER || 'thor1kvault-sudo';
const REPO        = 'thor1kvault-sudo/wel-bot-all.git';

// --- Helpers ---
function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    return (result || '').trim();
  } catch (err) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

// --- Main ---
(async () => {
  // Build commit message
  const customMsg = process.argv.slice(2).join(' ').trim();
  const now = new Date();
  const timestamp = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const commitMsg = customMsg || `chore: auto-push [${timestamp} IST]`;

  // Set authenticated remote URL if PAT is available
  let remoteRestored = false;
  if (GITHUB_PAT) {
    run(`git remote set-url origin https://${GITHUB_USER}:${GITHUB_PAT}@github.com/${REPO}`);
    remoteRestored = true;
  }

  try {
    // 1. Check for changes
    const status = run('git status --porcelain');
    if (!status) {
      log('✅', 'Nothing to commit — working tree is clean.');
      log('🚀', 'Pushing any unpushed commits to GitHub...');
    } else {
      // 2. Stage all changes
      log('📦', 'Staging all changes...');
      run('git add -A');

      // 3. Show what's being committed
      const staged = run('git diff --cached --stat');
      if (staged) console.log('\n' + staged + '\n');

      // 4. Commit
      log('💾', `Committing: "${commitMsg}"`);
      run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    }

    // 5. Push
    log('🚀', 'Pushing to GitHub...');
    const pushOut = run('git push origin main');
    if (pushOut) console.log(pushOut);

    log('✅', `Successfully pushed to https://github.com/${REPO}`);
  } catch (err) {
    console.error('\n❌  Push failed!\n');
    console.error(err.message);
    process.exit(1);
  } finally {
    // Always restore clean remote URL (no token exposed)
    if (remoteRestored) {
      run(`git remote set-url origin https://github.com/${REPO}`);
    }
  }
})();
