'use strict';

// WIN-002: the runner against REAL Windows programs (Windows only). The fake-process
// tests prove the logic; this proves the parts only the machine can: that the absolute
// paths exist, that the deadline really ends a hung PowerShell, and that taskkill /T takes
// the programs it started with it — the csc.exe that Add-Type starts, in miniature.
// Nothing here touches the desktop, the theme or the registry beyond one read.
//   node test/child-runner-live.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChildRunner, systemExecutable } = require('../src/child-runner');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pids, ms) {
  const until = Date.now() + ms;
  while (pids.some(alive)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return true;
}

(async () => {
  if (process.platform !== 'win32') { console.log('SKIPPED: not Windows'); return; }

  const powershell = systemExecutable('powershell');
  const reg = systemExecutable('reg');
  for (const program of [powershell, reg, systemExecutable('taskkill')]) {
    assert.ok(fs.existsSync(program), `no such program: ${program}`);
  }

  const runner = createChildRunner();

  // An ordinary run answers.
  const hello = await runner.run(powershell, ['-NoProfile', '-Command', 'Write-Output ok'], { timeoutMs: 30000 });
  assert.strictEqual(hello.stdout.trim(), 'ok');

  // A read-only reg.exe answers too.
  const theme = await runner.run(reg,
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
    { timeoutMs: 10000 }).catch((error) => error);
  assert.ok(!(theme instanceof Error) || theme.code === 'failed', `reg.exe did not run: ${theme && theme.message}`);

  // A PowerShell that hangs, with a program of its own under it: both are gone after the
  // deadline. The PIDs come back through a file, since a killed run returns no output.
  const pidFile = path.join(os.tmpdir(), `znada-win002-${process.pid}-${Date.now()}.txt`);
  const script = [
    "$child = Start-Process -FilePath $env:ZNADA_WIN002_PS -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru",
    'Set-Content -LiteralPath $env:ZNADA_WIN002_PIDS -Value ("$PID " + $child.Id)',
    'Start-Sleep -Seconds 60',
  ].join('; ');
  process.env.ZNADA_WIN002_PS = powershell;
  process.env.ZNADA_WIN002_PIDS = pidFile;
  const started = Date.now();
  const hung = await runner.run(powershell, ['-NoProfile', '-Command', script], { timeoutMs: 6000 })
    .then(() => null, (error) => error);
  const took = Date.now() - started;
  assert.ok(hung && hung.code === 'timeout', `the hung PowerShell was not ended at its deadline: ${hung && hung.message}`);
  assert.ok(took < 12000, `the deadline took ${took} ms`);

  let pids = [];
  try {
    pids = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter((n) => n > 0);
  } finally {
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }
  assert.strictEqual(pids.length, 2, `expected the PowerShell and its child, got: ${pids.join(' ')}`);
  assert.ok(await waitGone(pids, 5000), `still running after the deadline: ${pids.filter(alive).join(' ')}`);
  assert.strictEqual(runner.activeCount(), 0);

  console.log(`child-runner-live.test.js ok (deadline ended the tree in ${took} ms)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
