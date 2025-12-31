// 提交登录后：用 UI 硬标识判断，避免 Logs 误判
const invalidBanner = page.getByText(/Invalid credentials\.?/i);
const ownerText = page.getByText(/You are the exclusive owner of the following domains\./i);

// 等待“失败或成功”任意一个出现
await Promise.race([
  invalidBanner.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'fail'),
  ownerText.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'ok'),
]).catch(() => null);

// 最终裁决（失败永远优先）
const hasInvalid = await invalidBanner.isVisible().catch(() => false);
const hasOwner = await ownerText.isVisible().catch(() => false);

console.log(`🔍 ${user} - 判定: invalid=${hasInvalid}, ownerText=${hasOwner}`);

if (hasInvalid) {
  console.log(`❌ ${user} - 登录失败: 账号或密码错误`);
  result.message = `❌ ${user} 登录失败: 账号或密码错误`;
} else if (hasOwner) {
  console.log(`✅ ${user} - 登录成功`);
  result.success = true;
  result.message = `✅ ${user} 登录成功`;
} else {
  console.log(`❌ ${user} - 登录失败: 未检测到成功/失败标识`);
  result.message = `❌ ${user} 登录失败: 未检测到成功/失败标识`;
}
