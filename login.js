console.log('### login.js VERSION 2025-12-31 v2 ###');

async function hasTopInvalidBanner(page) {
  const loc = page.getByText(/Invalid credentials/i);
  const n = await loc.count();
  let minY = Infinity;

  for (let i = 0; i < n; i++) {
    const item = loc.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box && typeof box.y === 'number') minY = Math.min(minY, box.y);
  }

  // 顶部红条一般在很上面；Logs 在较下面
  return minY < 200;
}

async function isMyDomainsVisible(page) {
  const loc = page.getByText(/^My domains$/i);
  const visible = await loc.first().isVisible().catch(() => false);
  if (!visible) return false;

  // 防止极端情况下 “My domains” 出现在很下面（比如日志/隐藏区域）
  const box = await loc.first().boundingBox().catch(() => null);
  return !!box && box.y < 500;
}

async function loginWithAccount(user, pass) {
  console.log(`\n🚀 开始登录账号: ${user}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  let result = { user, success: false, message: '' };
  const safeUser = user.replace(/[^a-zA-Z0-9_-]/g, '_');

  try {
    // 额外保险：清空存储，避免“旧 token 导致错密码仍显示已登录”
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
    });

    console.log(`📱 ${user} - 正在访问网站...`);
    await page.goto('https://www.netlib.re/', { waitUntil: 'domcontentloaded' });

    console.log(`🔑 ${user} - 点击登录按钮...`);
    // 你截图里右上角 Login 更像 link，不是 button：优先点 link
    const loginLink = page.getByRole('link', { name: /^login$/i });
    if (await loginLink.count()) await loginLink.first().click();
    else await page.getByText(/^login$/i).click();

    console.log(`📝 ${user} - 填写用户名...`);
    await page.locator('input[name="username"]').fill(user);

    console.log(`🔒 ${user} - 填写密码...`);
    await page.locator('input[name="password"]').fill(pass);

    console.log(`📤 ${user} - 提交登录...`);
    await page.getByRole('button', { name: /^validate$/i }).click();

    // 等待页面产生“成功或失败”的任意信号（最多 15s）
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const topInvalid = await hasTopInvalidBanner(page);
      const myDomains = await isMyDomainsVisible(page);
      if (topInvalid || myDomains) break;
      await page.waitForTimeout(250);
    }

    const topInvalid = await hasTopInvalidBanner(page);
    const myDomains = await isMyDomainsVisible(page);

    console.log(`🔍 ${user} - 判定: topInvalid=${topInvalid}, myDomains=${myDomains}`);

    // 失败永远优先（避免同屏 Logs 同时出现“成功字样”）
    if (topInvalid) {
      result.success = false;
      result.message = `❌ ${user} 登录失败: 账号或密码错误`;
      await page.screenshot({ path: `fail_${safeUser}.png`, fullPage: true }).catch(() => {});
    } else if (myDomains) {
      result.success = true;
      result.message = `✅ ${user} 登录成功`;
    } else {
      result.success = false;
      result.message = `❌ ${user} 登录失败: 未检测到成功页(My domains)或错误条`;
      await page.screenshot({ path: `unknown_${safeUser}.png`, fullPage: true }).catch(() => {});
    }

  } catch (e) {
    result.success = false;
    result.message = `❌ ${user} 登录异常: ${e.message}`;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}
