// auto-shutdown-on-campaign-complete.js
// Monitors FindUrJob until the active campaign run completes,
// stops docker containers cleanly, and shuts down the Windows PC.

const http = require('http');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'auto-shutdown.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

let consecutiveFinishedCount = 0;
const REQUIRED_CONSECUTIVE_CHECKS = 2; // 2 consecutive checks ~ 30s confirmation
let initialRunSeen = false;

log('=== Auto-Shutdown Monitor Started ===');
log('Waiting for the current active campaign to complete...');

const interval = setInterval(async () => {
  try {
    const [campaign, run] = await Promise.all([
      fetchJson('http://localhost:4000/api/campagne'),
      fetchJson('http://localhost:4000/api/campagne/logs')
    ]);

    const isRunning = campaign.status === 'running' || !run.finishedAt;
    const lastLog = run.logs && run.logs.length > 0 ? run.logs[run.logs.length - 1] : '';

    if (isRunning) {
      initialRunSeen = true;
      consecutiveFinishedCount = 0;
      log(`[RUNNING] Run ID: ${run.id} | Logs: ${run.logs ? run.logs.length : 0} | Last: "${lastLog.slice(0, 75)}"`);
    } else {
      consecutiveFinishedCount++;
      log(`[COMPLETED CHECK ${consecutiveFinishedCount}/${REQUIRED_CONSECUTIVE_CHECKS}] Campaign status: ${campaign.status}, finishedAt: ${run.finishedAt}`);

      if (consecutiveFinishedCount >= REQUIRED_CONSECUTIVE_CHECKS) {
        clearInterval(interval);
        log('>>> CAMPAIGN COMPLETED SUCCESSFULLY! Initiating shutdown procedure... <<<');

        // Stop Docker containers cleanly so database and redis flush cleanly
        try {
          log('Stopping Docker containers cleanly...');
          execSync('docker-compose stop', { cwd: __dirname, timeout: 60000 });
          log('Docker containers successfully stopped.');
        } catch (dockerErr) {
          log('Docker stop warning: ' + dockerErr.message);
        }

        log('Triggering Windows system shutdown with 60-second countdown...');
        exec('shutdown /s /t 60 /c "FindUrJob campaign has completed successfully. Shutting down system in 60s (run shutdown /a to abort)."', (err) => {
          if (err) {
            log('Error triggering shutdown: ' + err.message);
          } else {
            log('Shutdown command executed successfully.');
          }
        });
      }
    }
  } catch (err) {
    log('Polling error: ' + err.message);
  }
}, 15000);
