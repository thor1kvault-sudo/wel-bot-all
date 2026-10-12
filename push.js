#!/usr/bin/env node
/**
 * push.js — Auto-commit and push all changes to GitHub
 * Usage: node push.js [optional commit message]
 *        npm run push
 *        npm run push -- "your custom message"
 */

const { execSync } = require('child_process');

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
    log('🚀', 'Pushing to GitHub (origin/main)...');
    const pushOut = run('git push origin main');
    if (pushOut) console.log(pushOut);

    log('✅', 'Successfully pushed to https://github.com/thor1kvault-sudo/wel-bot-all.git');
  } catch (err) {
    console.error('\n❌  Push failed!\n');
    console.error(err.message);

    // Helpful hint for auth errors
    if (err.message.includes('Authentication') || err.message.includes('403') || err.message.includes('credential')) {
      console.error('\n💡  Tip: GitHub no longer accepts passwords for HTTPS pushes.');
      console.error('    You need a Personal Access Token (PAT).');
      console.error('    Steps:');
      console.error('    1. Go to https://github.com/settings/tokens/new');
      console.error('    2. Create a token with "repo" scope');
      console.error('    3. When git asks for a password, paste your PAT instead');
      console.error('    4. Windows Credential Manager will save it for future pushes\n');
    }
    process.exit(1);
  }
})();
