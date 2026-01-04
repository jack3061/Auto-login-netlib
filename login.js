/**
 * Netlib auto login (robust for GitHub Actions)
 * Key fixes:
 * - Capture console + websocket logs (do NOT rely on document.body.innerText)
 * - Escape username for RegExp
 * - Safer artifacts & file naming (avoid overwrite)
 *
 * Env:
 *  - ACCOUNTS_JSON='[{"user":"u1","pass":"p,;:"}]' (recommended)
 *  - ACCOUNTS="u1:pass1\nu2:pass2" (fallback)
 *  - BOT_TOKEN, CHAT_ID (optional)
 *  - BASE_URL="https://www.netlib.re/" (optional)
 *  - DEBUG_ACCOUNTS="1" (optional)
 *  - SAVE_ARTIFACTS="1" (optional, default 1 in CI)
 */

import axios from 'axios';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

console.log('### login.js (robust) ###');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;

const accountsJsonRaw = process.env.ACCOUNTS_JSON || '';
const accountsRaw = process.env.ACCOUNTS || '';
const baseUrlRaw = process.env.BASE_URL || 'https://www.netlib.re/';
const debugAccounts = String(process.env.DEBUG_ACCOUNTS || '') === '1';
const saveArtifacts =
  String(process.env.SAVE_ARTIFACTS || '') === '1' ||
  String(process.env.GITHUB_ACTIONS || '') === 'true'; // default on in Actions

function normalizeBaseUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}/`;
  } catch {
    return 'https://www.netlib.re/';
  }
}
const baseUrl = normalizeBaseUrl(baseUrlRaw);

function hktTimeString() {
  const now = new Date();
  const hk = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return hk.toISOString().replace('T', ' ').slice(0, 19) + ' HKT';
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sha8(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

function fileTag(user) {
  return `${safeName(user)}_${sha8(user)}`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAccountsJson(raw) {
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => ({
      user: x?.user != null ? String(x.user).trim() : '',
      pass: typeof x?.pass === 'string' ? x.pass : (x?.pass != null ? String(x.pass) : '')
    }))
    .filter(x => x.user && x.pass !== '');
}

/**
 * Fallback parse:
 * - recommended: newline separated
 * - legacy: comma/semicolon (unsafe if password contains , or ;)
 */
function parseAccounts(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];

  const hasNewline = /[\r\n]/.test(trimmed);

  let items;
  if (hasNewline) {
    items = trimmed.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else {
    items = trimmed.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (items.length > 1) {
      console.log(
        'WARN: ACCOUNTS 使用逗号/分号分隔；若密码包含 , 或 ; 会被截断。建议用换行或 ACCOUNTS_JSON。'
      );
    }
  }

  const list = [];
  for (const item of items) {
    const idx = item.indexOf(':');
    if (idx === -1) continue;
    const user = item.slice(0, idx).trim();
    const pass = item.slice(idx + 1); // do NOT trim
    if (user && pass !== '') list.push({ user, pass });
  }
  return list;
}

function getAccountList() {
  if (accountsJsonRaw) {
    try {
      const list = parseAccountsJson(accountsJsonRaw);
      if (list.length) return list;
      console.log('ERROR: ACCOUNTS_JSON 解析后为空，请检查 JSON 格式与字段 user/pass');
      process.exit(1);
    } catch (e) {
      console.log(`ERROR: ACCOUNTS_JSON 不是合法 JSON: ${e?.message || e}`);
      process.exit(1);
    }
  }

  if (!accountsRaw) {
    console.log('ERROR: 未配置账号: 请设置环境变量 ACCOUNTS_JSON 或 ACCOUNTS');
    process.exit(1);
  }

  const list = parseAccounts(accountsRaw);
  if (list.length === 0) {
    console.log(
      'ERROR: 账号格式错误，应为：\n' +
      '  - ACCOUNTS_JSON: [{"user":"u","pass":"p"}]\n' +
      '  - 或 ACCOUNTS 换行: user:pass\\nuser2:pass2'
    );
    process.exit(1);
  }
  return list;
}

const accountList = getAccountList();

if (debugAccounts) {
  console.log('### DEBUG_ACCOUNTS enabled (no plaintext password printed) ###');
  console.log(
    accountList.map(a => ({
      user: a.user,
      passLen: a.pass.length,
      passSha8: sha8(a.pass)
    }))
  );
}

function getActionsRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return '';
}

async function sendTelegram(message) {
  if (!token || !chatId) return;

  const maxLen = 3800;
  const text = message.length > maxLen ? message.slice(0, maxLen) + '\n\n...(truncated)' : message;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text },
      { timeout: 10000 }
    );
    console.log('INFO: Telegram 通知发送成功');
  } catch (e) {
    console.log(`WARN: Telegram 发送失败: ${e?.message || e}`);
  }
}

async function isDisconnected(page) {
  const banner = page.getByText(/You have been disconnected/i);
  return await banner.isVisible().catch(() => false);
}

async function waitForDisconnectedGone(page, timeoutMs = 30000) {
  const banner = page.getByText(/You have been disconnected/i);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const visible = await banner.isVisible().catch(() => false);
    if (!visible) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * Home readiness: do NOT hard-depend on one slogan.
 * We'll try several signals; if none appear, still continue (SPA may change copy).
 */
async function waitForHomeReady(page, timeoutMs = 40000) {
  const t0 = Date.now();

  // try known text
  const readNews = page.getByText(/Read the news!/i);
  // or any top-level nav links that usually exist
  const anyNav = page.getByRole('link').first();

  while (Date.now() - t0 < timeoutMs) {
    if (await isDisconnected(page)) {
      await waitForDisconnectedGone(page, 20000).catch(() => {});
    }

    const ok1 = await readNews.isVisible().catch(() => false);
    const ok2 = await anyNav.isVisible().catch(() => false);

    if (ok1 || ok2) return true;
    await page.waitForTimeout(350);
  }
  return !(await isDisconnected(page));
}

async function hasTopInvalidBanner(page) {
  const alertLoc = page
    .locator('.alert, .alert-danger, .notification, .toast, .snackbar')
    .filter({ hasText: /Invalid credentials/i });

  if (await alertLoc.first().isVisible().catch(() => false)) return true;

  const loc = page.getByText(/Invalid credentials\.?/i);
  const n = await loc.count().catch(() => 0);
  let minY = Infinity;

  for (let i = 0; i < n; i++) {
    const item = loc.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box && typeof box.y === 'number') minY = Math.min(minY, box.y);
  }
  return minY < 450;
}

async function getSuccessSignalsUI(page) {
  // UI signals are best-effort only
  const myDomainsHeading = page.getByRole('heading', { name: /my domains/i });
  const ownerText = page.getByText(/exclusive owner of the following domains/i);

  const hasMyDomains = await myDomainsHeading.first().isVisible().catch(() => false);
  const hasOwnerText = await ownerText.first().isVisible().catch(() => false);

  return { hasMyDomains, hasOwnerText, success: hasMyDomains || hasOwnerText };
}

function getLoginVerdictFromText(allText) {
  const text = String(allText || '');

  const hasInvalid = /Invalid credentials\.?/i.test(text);
  const hasAuthd = /Authenticated to authd\./i.test(text);
  const hasDns = /Authenticated to dnsmanagerd\./i.test(text);

  if (hasInvalid) return { verdict: 'FAIL_INVALID', snippet: text.slice(-4000) };
  if (hasAuthd && hasDns) return { verdict: 'SUCCESS', snippet: text.slice(-4000) };
  return { verdict: 'UNKNOWN', snippet: text.slice(-4000) };
}

async function isNotFoundPage(page) {
  const title = await page.title().catch(() => '');
  if (/404/i.test(title) || /not found/i.test(title)) return true;

  const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return /darkhttpd/i.test(body) || /The URL you requested was not found/i.test(body);
}

/**
 * Netlib is an SPA; avoid server deep-link like /auth (may 404).
 * Use hash routing ONLY.
 */
async function gotoLoginPage(page, baseUrl) {
  const userInput = page.locator('input[name="username"]').first();

  async function gotoHash(hashValueWithLeadingHash) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(h => { window.location.hash = h; }, hashValueWithLeadingHash).catch(() => {});
    await page.waitForTimeout(600);

    if (await isNotFoundPage(page)) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate(h => { window.location.hash = h; }, hashValueWithLeadingHash).catch(() => {});
      await page.waitForTimeout(800);
    }

    // Only click Authentication tab if it's hash-based
    const authTab = page.getByRole('link', { name: /^authentication$/i }).first();
    if (await authTab.isVisible().catch(() => false)) {
      const href = await authTab.getAttribute('href').catch(() => '');
      if (href && href.includes('#')) {
        await authTab.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    if (await userInput.isVisible().catch(() => false)) {
      return { ok: true, tried: `${baseUrl}${hashValueWithLeadingHash}` };
    }
    return { ok: false, tried: `${baseUrl}${hashValueWithLeadingHash}` };
  }

  const hashes = ['#/authentication', '#/login', '#/auth', '#/authentication/'];
  for (const h of hashes) {
    const r = await gotoHash(h);
    if (r.ok) return { ok: true, href: '', tried: r.tried };
  }

  // Last resort: click Login link only if hash-based
  const loginLink = page.getByRole('link', { name: /^(login|log in)$/i }).first();
  if (await loginLink.isVisible().catch(() => false)) {
    const href = await loginLink.getAttribute('href').catch(() => '');
    if (href && href.includes('#')) {
      await loginLink.click({ timeout: 10000, force: true }).catch(() => {});
      await page.waitForTimeout(600);
      if (await userInput.isVisible().catch(() => false)) {
        return { ok: true, href, tried: 'click(Login#)' };
      }
    } else {
      console.log(`WARN: Login link href=${href || '(null)'} 不含 #，为避免 404 已跳过点击。`);
    }
  }

  return { ok: false, href: '', tried: `${baseUrl}#/authentication` };
}

async function clickValidateScoped(page) {
  const userInput = page.locator('input[name="username"]').first();

  const form = userInput.locator('xpath=ancestor::form[1]');
  const formCount = await form.count().catch(() => 0);
  if (formCount > 0) {
    const btn = form.getByRole('button', { name: /^validate$/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 15000 });
      return { ok: true, used: 'form->Validate' };
    }
  }

  const panel = userInput.locator(
    'xpath=ancestor::*[self::div or self::section or self::main][.//input[@name="password"]][1]'
  );
  const panelCount = await panel.count().catch(() => 0);
  if (panelCount > 0) {
    const btn = panel.getByRole('button', { name: /^validate$/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 15000 });
      return { ok: true, used: 'panel->Validate' };
    }
  }

  await page.getByRole('button', { name: /^validate$/i }).first().click({ timeout: 15000 });
  return { ok: true, used: 'global->Validate' };
}

async function maybeWriteFile(relName, content) {
  if (!saveArtifacts) return;
  await fs.writeFile(path.join(__dirname, relName), content, 'utf8').catch(() => {});
}

async function maybeScreenshot(page, relName) {
  if (!saveArtifacts) return;
  await page.screenshot({ path: path.join(__dirname, relName), fullPage: true }).catch(() => {});
}

async function loginWithAccount(user, pass) {
  console.log(`\nSTART login: ${user}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // ---- capture console + websocket logs (critical for correct verdict) ----
  const runtimeLogs = [];
  function pushLog(line) {
    if (!line) return;
    runtimeLogs.push(String(line));
    if (runtimeLogs.length > 2500) runtimeLogs.shift();
  }

  page.on('console', msg => pushLog(`[console:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => pushLog(`[pageerror] ${err?.message || err}`));
  page.on('requestfailed', req => pushLog(`[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText || ''}`));

  page.on('websocket', ws => {
    pushLog(`[ws] opened ${ws.url()}`);
    ws.on('framereceived', f => pushLog(`[ws<-] ${f.payload}`));
    ws.on('framesent', f => pushLog(`[ws->] ${f.payload}`));
    ws.on('close', () => pushLog(`[ws] closed ${ws.url()}`));
  });

  const tag = fileTag(user);

  const result = {
    user,
    success: false,
    status: 'INIT',
    reason: '',
    url: '',
    title: '',
    nav: { href: '', tried: '' },
    evidence: {
      disconnected: false,
      topInvalid: false,
      uiMyDomains: false,
      uiOwnerText: false,
      logsVerdict: 'UNKNOWN'
    },
    logsSnippet: '',
    screenshot: ''
  };

  try {
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });

    console.log(`${user} goto home...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log(`${user} wait home ready + disconnected gone...`);
    const ready = await waitForHomeReady(page, 45000);
    if (!ready) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '首页长期处于 disconnected/未就绪（网络或 WS 不稳定）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');
      result.evidence.disconnected = await isDisconnected(page);

      result.screenshot = `disconnected_${tag}.png`;
      await maybeScreenshot(page, result.screenshot);
      const logs = getLoginVerdictFromText(runtimeLogs.join('\n'));
      result.evidence.logsVerdict = logs.verdict;
      result.logsSnippet = logs.snippet || '';
      await maybeWriteFile(`runtime_${tag}.txt`, runtimeLogs.join('\n'));
      return result;
    }

    console.log(`${user} open login page (hash route)...`);
    const nav = await gotoLoginPage(page, baseUrl);
    result.nav.href = nav.href || '';
    result.nav.tried = nav.tried || '';
    console.log(`${user} tried=${result.nav.tried}`);

    await waitForDisconnectedGone(page, 20000).catch(() => {});

    if (await isNotFoundPage(page)) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '进入登录页后落入 404（SPA 必须用 #/ 路由）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');

      result.screenshot = `no_login_page_${tag}.png`;
      await maybeScreenshot(page, result.screenshot);
      await maybeWriteFile(`runtime_${tag}.txt`, runtimeLogs.join('\n'));
      return result;
    }

    const userInput = page.locator('input[name="username"]').first();
    const passInput = page.locator('input[name="password"]').first();

    if (!(await userInput.isVisible().catch(() => false))) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '未找到 username 输入框（页面结构变化或未进入登录视图）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');

      result.screenshot = `no_login_ui_${tag}.png`;
      await maybeScreenshot(page, result.screenshot);
      await maybeWriteFile(`runtime_${tag}.txt`, runtimeLogs.join('\n'));
      return result;
    }

    await passInput.waitFor({ state: 'visible', timeout: 20000 });

    await userInput.fill(user);
    await passInput.fill(pass);

    const clickInfo = await clickValidateScoped(page).catch(e => ({ ok: false, used: `ERROR: ${e?.message || e}` }));
    console.log(`${user} Validate click=${clickInfo.used}`);

    // DO NOT embed raw user into regex without escaping
    const anchorLoc = page.getByText(new RegExp(`authenticate \\(login: ${escapeRegExp(user)}\\)`, 'i'));

    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      if (await isDisconnected(page)) {
        await waitForDisconnectedGone(page, 15000).catch(() => {});
      }

      // Prefer log-based verdict (most reliable in SPA+WS)
      const logsNow = getLoginVerdictFromText(runtimeLogs.join('\n'));
      if (logsNow.verdict === 'FAIL_INVALID' || logsNow.verdict === 'SUCCESS') break;

      const topInvalid = await hasTopInvalidBanner(page);
      if (topInvalid) break;

      const ui = await getSuccessSignalsUI(page);
      if (ui.success) break;

      const hasAnchor = await anchorLoc.first().isVisible().catch(() => false);
      if (hasAnchor) {
        // anchor is a weak signal; still allow loop to end
        break;
      }

      await page.waitForTimeout(350);
    }

    await page.waitForTimeout(1200);

    result.url = page.url();
    result.title = await page.title().catch(() => '');
    result.evidence.disconnected = await isDisconnected(page);

    result.evidence.topInvalid = await hasTopInvalidBanner(page);
    const ui = await getSuccessSignalsUI(page);
    result.evidence.uiMyDomains = ui.hasMyDomains;
    result.evidence.uiOwnerText = ui.hasOwnerText;

    const logs = getLoginVerdictFromText(runtimeLogs.join('\n'));
    result.evidence.logsVerdict = logs.verdict;
    result.logsSnippet = logs.snippet || '';

    await maybeWriteFile(`runtime_${tag}.txt`, runtimeLogs.join('\n'));

    if (result.evidence.topInvalid || logs.verdict === 'FAIL_INVALID') {
      result.status = 'FAIL_INVALID';
      result.reason = '账号或密码错误（UI 或运行日志检测到 Invalid credentials）';
      result.success = false;

      // reduce leakage: clear password field before screenshot
      await passInput.fill('').catch(() => {});
      result.screenshot = `fail_${tag}.png`;
      await maybeScreenshot(page, result.screenshot);
      return result;
    }

    if (ui.success || logs.verdict === 'SUCCESS') {
      result.status = 'SUCCESS';
      result.reason = logs.verdict === 'SUCCESS'
        ? '运行日志检测到 Authenticated to authd + dnsmanagerd'
        : (ui.hasMyDomains ? 'UI 检测到 My domains' : 'UI 检测到 owner 文案');
      result.success = true;
      return result;
    }

    result.status = 'FAIL_UNKNOWN';
    result.reason = result.evidence.disconnected
      ? '未能判定：提交后仍处于 disconnected 或日志不完整（查看 runtime_*.txt 与截图）'
      : '未能判定：未出现明确 SUCCESS/Invalid（查看 runtime_*.txt 与截图）';
    result.success = false;

    await passInput.fill('').catch(() => {});
    result.screenshot = `unknown_${tag}.png`;
    await maybeScreenshot(page, result.screenshot);
    return result;

  } catch (e) {
    result.status = 'ERROR';
    result.success = false;
    result.reason = `脚本异常: ${e?.message || e}`;
    result.url = page?.url?.() || '';
    result.title = await page?.title?.().catch(() => '') || '';
    result.evidence.disconnected = await isDisconnected(page).catch(() => false);

    await maybeWriteFile(`runtime_${tag}.txt`, runtimeLogs.join('\n'));

    result.screenshot = `error_${tag}.png`;
    await maybeScreenshot(page, result.screenshot);
    return result;

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function formatResultBlock(r) {
  const statusZh = {
    SUCCESS: '成功',
    FAIL_INVALID: '失败-密码错误',
    FAIL_UNKNOWN: '失败-未判定',
    ERROR: '异常'
  }[r.status] || r.status;

  const ev = r.evidence || {};
  const nav = r.nav || {};

  let s =
    `账号：${r.user}\n` +
    `结果：${statusZh} (${r.status})\n` +
    `原因：${r.reason}\n` +
    `证据：disconnected=${!!ev.disconnected}, topInvalid=${!!ev.topInvalid}, uiMyDomains=${!!ev.uiMyDomains}, uiOwnerText=${!!ev.uiOwnerText}, logsVerdict=${ev.logsVerdict}\n` +
    `Login入口：href=${nav.href || '(null)'} ; tried=${nav.tried || '(none)'}\n`;

  if (r.title) s += `Title：${r.title}\n`;
  if (r.url) s += `URL：${r.url}\n`;
  if (r.screenshot) s += `截图：${r.screenshot}\n`;
  if (saveArtifacts) s += `运行日志：runtime_${fileTag(r.user)}.txt\n`;

  if (r.logsSnippet) {
    const preview = r.logsSnippet.split('\n').slice(0, 10).join('\n');
    s += `Logs预览：\n${preview}\n`;
  }

  return s;
}

async function main() {
  console.log(`INFO: accounts=${accountList.length}, baseUrl=${baseUrl}, saveArtifacts=${saveArtifacts}`);

  const results = [];

  for (let i = 0; i < accountList.length; i++) {
    const { user, pass } = accountList[i];
    console.log(`\nINFO: account ${i + 1}/${accountList.length}: ${user}`);

    const r = await loginWithAccount(user, pass);
    results.push(r);

    if (i < accountList.length - 1) {
      await new Promise(res => setTimeout(res, 3000));
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const runUrl = getActionsRunUrl();

  let msg =
    `Netlib 登录通知\n` +
    `时间：${hktTimeString()}\n` +
    (runUrl ? `Run：${runUrl}\n` : '') +
    `\n` +
    `汇总：成功 ${counts.SUCCESS || 0}；密码错误 ${counts.FAIL_INVALID || 0}；未判定 ${counts.FAIL_UNKNOWN || 0}；异常 ${counts.ERROR || 0}\n\n`;

  for (const r of results) {
    msg += formatResultBlock(r) + '\n';
  }

  await sendTelegram(msg);
  console.log('INFO: done');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
