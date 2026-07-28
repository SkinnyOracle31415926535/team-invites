const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');
const { chromium } = require('playwright');

const root = normalize(join(__dirname, '..'));
const screenshotRoot = '/private/tmp';
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const syncClient = readFileSync(
  '/Users/ryansadler/Developer/ryan-app-sync/public/ryan-app-sync.js',
  'utf8',
);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new Error('outside root');
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (_error) {
    response.writeHead(404);
    response.end('Not found');
  }
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const legacyConfig = '{"projectUrl":"https://old.example","anonKey":"preserve-config"}';
  const legacySession = '{"accessToken":"preserve-session","refreshToken":"do-not-touch"}';

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.addInitScript(({ legacyConfig, legacySession }) => {
    localStorage.setItem('team-invites-sync-config-v1', legacyConfig);
    localStorage.setItem('team-invites-sync-session-v1', legacySession);
    localStorage.setItem('team-invites-local-backup-legacy', '{"remote":"preserve"}');
  }, { legacyConfig, legacySession });
  await page.route(
    'https://ryan-app-sync.ryan-666-mp3.chatgpt.site/ryan-app-sync.js',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: syncClient,
    }),
  );

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.locator('#syncButton[data-state]').waitFor();
    assert.equal(await page.locator('#usagTab').getAttribute('aria-selected'), 'true');

    await page.locator('#newInviteButton').click();
    await page.locator('#editorBody [data-field="athleteName"]').fill('Visual Smoke Athlete');
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem('team-invites-v1'));
      return value.invites.length === 1 &&
        value.invites[0].athleteName === 'Visual Smoke Athlete';
    });

    await page.locator('#templateButton').click();
    await page.locator('#templateFields [data-field="level"]').fill('Smoke Level');
    await page.locator('#doneTemplateButton').click();
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem('team-invites-v1'));
      return value.templates.USAG.level === 'Smoke Level';
    });

    await page.locator('#ngaTab').click();
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem('team-invites-v1'));
      return value.preferences.activeProgram === 'NGA';
    });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#ngaTab').getAttribute('aria-selected'), 'true');
    await page.locator('#usagTab').click();
    assert.equal(await page.locator('.record-card').count(), 1);
    assert.match(await page.locator('.record-card').innerText(), /Visual Smoke Athlete/);

    const viewports = [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#syncButton').click();
      await page.locator('.team-sync-dialog').waitFor({ state: 'visible' });
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        dialogOpen: document.querySelector('.team-sync-dialog')?.open === true,
        actions: document.querySelectorAll('.team-sync-actions button').length,
        warning: document.querySelector('[data-team-storage-warning]')?.textContent || '',
        legacyDialogOpen: document.querySelector('#syncDialog')?.open === true,
        reviewVisible:
          getComputedStyle(document.querySelector('[data-team-sync-review]')).display !== 'none',
        conflictsVisible:
          getComputedStyle(document.querySelector('[data-team-sync-conflicts]')).display !== 'none',
      }));
      assert.equal(layout.dialogOpen, true);
      assert.equal(layout.legacyDialogOpen, false);
      assert.equal(layout.actions, 6);
      assert.equal(layout.reviewVisible, false);
      assert.equal(layout.conflictsVisible, false);
      assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify({ viewport, layout }));
      assert.equal(layout.warning, '');
      await page.screenshot({
        path: join(screenshotRoot, `team-invites-sync-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator('[data-team-sync-close]').click();
    }

    const persisted = await page.evaluate(() => ({
      state: JSON.parse(localStorage.getItem('team-invites-v1')),
      config: localStorage.getItem('team-invites-sync-config-v1'),
      session: localStorage.getItem('team-invites-sync-session-v1'),
      oldRemote: localStorage.getItem('team-invites-local-backup-legacy'),
      backup: window.TeamInvitesStorage.rawBackup(),
    }));
    assert.equal(persisted.state.invites.length, 1);
    assert.equal(persisted.state.invites[0].athleteName, 'Visual Smoke Athlete');
    assert.equal(persisted.state.templates.USAG.level, 'Smoke Level');
    assert.equal(persisted.config, legacyConfig);
    assert.equal(persisted.session, legacySession);
    assert.equal(persisted.oldRemote, '{"remote":"preserve"}');
    assert.deepEqual(
      Array.from(persisted.backup.records, (record) => record.key),
      ['team-invites-v1'],
    );
    assert.doesNotMatch(JSON.stringify(persisted.backup), /preserve-config|preserve-session/);
    assert.equal(
      requests.some((url) => /team_invitation_states|\/auth\/v1\//.test(url)),
      false,
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    process.stdout.write(
      'Team Invites headless smoke: 375/768/1440, persistence, exact backup, legacy preservation, sync dialog, zero_open PASS\n',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
