const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const buildInfoPath = path.resolve(__dirname, '..', 'lib', 'build-info.json');

let currentBuild = 52;
try {
  if (fs.existsSync(buildInfoPath)) {
    const data = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    currentBuild = Number(data.build) || currentBuild;
  }
} catch { /* ignore */ }

let gitCount = null;
let gitSha = '';
try {
  gitCount = parseInt(execSync('git rev-list --count HEAD', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim(), 10);
  gitSha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
} catch {
  gitSha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
}

const nextBuild = gitCount ? Math.max(gitCount, currentBuild + 1) : currentBuild + 1;

const now = new Date();
const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' +
  now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const buildInfo = {
  build: nextBuild,
  commit: gitSha,
  date: dateStr,
};

fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2), 'utf8');
console.log(`[BuildInfo] Set Build #${nextBuild} (${dateStr}, ${gitSha})`);
