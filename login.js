async function loginWithAccount(user, pass) {
  console.log(`\n🚀 开始登录账号: ${user}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let result = { user, success: false, message: '' };
  const safeUser = user.replace(/[^a-zA-Z0-9_-]/g, '_');

  // 用 context 能更干净（localStorage/cookie 完全隔离）
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    console.log(`📱 ${user} - 正在访问网站...`);
    await page.goto('https://www.netlib.re/', { waitUntil: 'domcontentloaded' });

    console.log(`🔑 ${user} - 点击登录按钮...`);
    // 你说 login 是按钮：优先按 role 点击，失败再降级 text
    const loginBtn = page.getByRole('button', { name: /^login$/i });
    if (await loginBtn.count()) await loginBtn.first().click();
    else await page.getByText(/^login$/i).click();

    console.log(`📝 ${user} - 填写用户名/密码...`);
    await page.getByLabel(/username/i).fill(user).catch(async () => {
      await page.locator('input[name="username"]').fill(user);
    });

    await page.getByLabel(/password/i).fill(pass).catch(async () => {
      await page.locator('input[name="password"]').fill(pass);
    });

    console.log(`📤 ${user} - 点击 Validate...`);
    await page.getByRole('button', { name: /^validate$/i }).click();

    // —— 核心：用“可见元素”判定成功/失败 ——
    const invalidBanner = page.getByText(/Invalid credentials\.?/i);
    const myDomainsTitle = page.getByRole('heading', { name: /^My domains$/i });

    // 等待失败或成功任意一个先出现
    await Promise.race([
      invalidBanner.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'fail'),
      myDomainsTitle.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'ok'),
    ]).catch(() => null);

    // 最终裁决：失败永远优先
    const hasInvalid = await invalidBanner.isVisible().catch(() => false);
    const hasMyDomains = await myDomainsTitle.isVisible().catch(() => false);

    console.log(`🔍 ${user} - visible检查: invalid=${hasInvalid}, myDomains=${hasMyDomains}`);

    if (hasInvalid) {
      result.success = false;
      result.message = `❌ ${user} 登录失败: 账号或密码错误`;
      await page.screenshot({ path: `fail_${safeUser}.png`, fullPage: true }).catch(() => {});
    } else if (hasMyDomains) {
      result.success = true;
      result.message = `✅ ${user} 登录成功`;
    } else {
      // 两者都没等到：当作失败（并截图便于定位）
      result.success = false;
      result.message = `❌ ${user} 登录失败: 未出现成功页面(My domains)`;
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
