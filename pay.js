const PAY_CONFIG = {
  // 授权主通道（Supabase Edge Function）。
  api: "https://kzqgphxrghdclkwneqyn.supabase.co/functions/v1/auth",
  qr: {
    alipay: "./assets/alipay-qr.png",
    wechat: "./assets/wechat-qr.png",
  },
  channelName: { alipay: "支付宝收款", wechat: "微信收款" },
  // 价格不在这里写死：站主可以在管理台调价，页面上的 ￥ 必须由 /v1/orders/stock 带回。
};

const STORAGE_KEY = "cskin.pay.order.v2";
const POLL_MS = 5000;
const TICK_MS = 1000;

const $ = (selector) => document.querySelector(selector);
const state = {
  plan: "7",
  method: "alipay",
  order: null,
  code: "",
  generation: 0,
  pollTimer: null,
  tickTimer: null,
  expired: false,
  locked: false,
  stockLevels: {},
  prices: {},
};

const STOCK_LABELS = { ok: "库存充足", low: "库存不多", out: "暂时售罄" };

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2600);
}

/** 整数分 → 「元.角分」。不能用 cents/100 的浮点结果，否则会出现 20.139999。 */
function yuan(cents) {
  const value = Number(cents);
  if (!Number.isInteger(value) || value < 0) return "--";
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
const pad2 = (value) => String(value).padStart(2, "0");

/* ---------- 液态控件：滑动指示块 + 跟随指针的镜面高光 ---------- */

/* ---------- 状态机 ---------- */

function showStage(name) {
  for (const stage of document.querySelectorAll(".stage")) {
    stage.hidden = stage.dataset.stage !== name;
  }
}

function setPlan(plan) {
  state.plan = String(plan);
  for (const button of document.querySelectorAll("[data-plan]")) {
    const on = button.dataset.plan === state.plan;
    button.setAttribute("aria-checked", String(on));
  }
  renderStock();
}

function setMethod(method) {
  state.method = method;
  for (const button of document.querySelectorAll("[data-method]")) {
    button.setAttribute("aria-checked", String(button.dataset.method === method));
  }
  $("#pay-channel").textContent = PAY_CONFIG.channelName[method] || "收款码";
  loadQr();
}

function lock(locked) {
  // 建单之后再换套餐或换支付方式，买家很可能按新选的去付款，而订单还是旧金额，
  // 结果钱进了一个没有对应订单的金额上。
  state.locked = locked;
  for (const button of document.querySelectorAll("[data-plan],[data-method]")) button.disabled = locked;
  for (const input of document.querySelectorAll("#order-form input")) input.readOnly = locked;
  // 售罄时直接按住按钮：让人点了才告诉他「待支付订单过多」是白跑一趟。
  const soldOut = !locked && state.stockLevels[state.plan] === "out";
  $("#create-order").disabled = locked || soldOut;
  $("#create-order").textContent = locked ? "订单已生成 · 请扫码付款" : soldOut ? "当前套餐暂时售罄" : "生成支付码";
}

function renderStock() {
  const badge = $("#stock");
  const level = state.stockLevels[state.plan];
  if (!level || !STOCK_LABELS[level]) {
    badge.hidden = true;
  } else {
    badge.textContent = STOCK_LABELS[level];
    badge.dataset.level = level;
    badge.hidden = false;
  }
  lock(state.locked);
}

function setServiceState(ok) {
  const el = $("#service-state");
  if (!el) return;
  el.dataset.state = ok ? "ok" : "down";
  el.textContent = ok ? "服务正常" : "连不上授权服务";
}

/**
 * 页面上的价格必须来自服务端：站主在管理台调过价之后，买家照着旧数字转账就会变成
 * 一笔没有对应订单的到账。没带回价格时保持原样（服务端此时也在用同一组默认价），
 * 而不是抹成「—」——空白的价格比一个正确的价格更容易让人以为页面坏了。
 */
function applyPrices(prices) {
  if (!prices || typeof prices !== "object") return;
  state.prices = prices;
  for (const button of document.querySelectorAll("[data-plan]")) {
    const cents = Number(prices[button.dataset.plan]);
    const label = button.querySelector("i");
    if (!label || !Number.isFinite(cents) || cents <= 0) continue;
    label.textContent = `￥${Math.round(cents / 100)}`;
  }
}

async function loadStock() {
  try {
    const response = await fetch(`${PAY_CONFIG.api}/v1/orders/stock`, { cache: "no-store" });
    if (!response.ok) { setServiceState(false); return; }
    const result = await response.json().catch(() => ({}));
    if (!result || typeof result.stock !== "object" || result.stock === null) { setServiceState(false); return; }
    state.stockLevels = result.stock;
    applyPrices(result.prices);
    setServiceState(true);
    renderStock();
  } catch {
    // 拿不到档位就什么都不显示——宁可少一个提示，也不要摆一个假的「充足」骗人。
    setServiceState(false);
  }
}

function clearTimers() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function reset() {
  clearTimers();
  state.order = null;
  state.code = "";
  state.expired = false;
  state.generation += 1;
  forget();
}

/* ---------- 会话恢复：刷新后必须还能取回买家扫的那张码 ---------- */

function remember(order) {
  try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch { /* 隐私模式只是失去恢复能力 */ }
}
function recall() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const order = JSON.parse(raw);
    if (!order || typeof order.orderId !== "string" || typeof order.orderToken !== "string") return null;
    if (Number(order.expiresAt) * 1000 < Date.now()) return null;
    return order;
  } catch { return null; }
}
function forget() {
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* 忽略 */ }
}

/* ---------- 倒计时 ---------- */

function renderTimer(order) {
  const now = Math.floor(Date.now() / 1000);
  const total = Math.max(1, Number(order.expiresAt) - Number(order.createdAt || order.expiresAt - 120));
  const remain = Math.max(0, Number(order.expiresAt) - now);
  $("#timer-clock").textContent = `${pad2(Math.floor(remain / 60))}:${pad2(remain % 60)}`;
  $("#timer-fill").style.setProperty("--left", String(remain / total));
  $("#timer-state").textContent = remain === 0 ? "已过期" : "等待支付";
  $("#timer-state").closest(".countdown").dataset.expired = remain === 0 ? "true" : "false";
  return remain;
}

function startTimer(order) {
  if (state.tickTimer) clearInterval(state.tickTimer);
  if (renderTimer(order) === 0) { expire(); return; }
  state.tickTimer = setInterval(() => {
    if (renderTimer(order) === 0) { clearInterval(state.tickTimer); state.tickTimer = null; expire(); }
  }, TICK_MS);
}

/**
 * 倒计时归零就本地判过期，不等下一次轮询：轮询间隔 5 秒且网络抖动时更久，
 * 买家完全可能对着一个已经作废的二维码继续付款。
 */
function expire() {
  clearTimers();
  state.expired = true;
  forget();
  lock(false);
  showStage("expired");
}

/* ---------- 收款码 ---------- */

function loadQr() {
  const image = $("#qr-image");
  const fallback = $("#qr-fallback");
  const source = PAY_CONFIG.qr[state.method];
  if (!source) return;
  // 切换渠道时先收起上一张码：不能让买家在新图解码完成前对着另一个渠道的码扫码。
  image.hidden = true;
  fallback.hidden = true;
  image.src = source;
  if (image.complete && image.naturalWidth > 0) image.hidden = false;
}

/* ---------- 与授权服务通信 ---------- */

function readForm() {
  const contact = $("#contact").value.trim();
  const password = $("#password").value;
  const confirm = $("#password2").value;
  const email = /^[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]{2,}$/.test(contact) && contact.length <= 200;
  const phone = /^1[3-9]\d{9}$/.test(contact.replace(/[^\d]/g, "").replace(/^86/, ""));
  if (!email && !phone) return { error: "请填写可用的邮箱或 11 位手机号" };
  if (password.length < 4 || password.length > 64) return { error: "查询密码需要 4–64 位" };
  if (password !== confirm) return { error: "两次输入的查询密码不一致" };
  return { contact, password };
}

async function createOrder() {
  if (state.locked) return;
  const values = readForm();
  const hint = $("#form-hint");
  if (values.error) {
    hint.textContent = values.error;
    hint.classList.add("is-error");
    toast(values.error);
    return;
  }
  hint.classList.remove("is-error");
  hint.textContent = "正在分配订单金额尾数…";
  reset();
  lock(true);
  const generation = state.generation;
  try {
    const response = await fetch(`${PAY_CONFIG.api}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planDays: Number(state.plan), paymentMethod: state.method, contact: values.contact, queryPassword: values.password }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 429 是限流、503 是尾数池被占满，两者都跟买家填的内容无关，
      // 再让他「检查联系方式与密码」只会诱导人反复改本来正确的东西。
      const later = response.status === 429 || response.status === 503;
      const error = new Error(result?.error?.message || (later ? "订单服务繁忙" : "订单服务暂不可用"));
      error.later = later;
      throw error;
    }
    if (generation !== state.generation) return;
    state.order = result;
    remember(result);
    showOrder(result);
    poll(generation);
  } catch (error) {
    if (generation !== state.generation) return;
    lock(false);
    hint.textContent = error.later ? `${error.message}，请稍等几分钟再试一次` : `${error.message}，请检查填写内容`;
    hint.classList.add("is-error");
    toast(error.later ? "稍等几分钟再试，填写内容不用改" : error.message);
  }
}

function showOrder(order) {
  const amount = `￥${yuan(order.amountCents)}`;
  $("#pay-amount").textContent = amount;
  $("#mustpay").textContent = `务必付款 ${amount}，否则无法自动到账`;
  $("#pay-channel").textContent = PAY_CONFIG.channelName[order.paymentMethod] || "收款码";
  loadQr();
  showStage("pay");
  startTimer(order);
}

async function poll(generation) {
  if (generation !== state.generation || !state.order || state.expired) return;
  try {
    const url = `${PAY_CONFIG.api}/v1/orders/${encodeURIComponent(state.order.orderId)}?token=${encodeURIComponent(state.order.orderToken)}`;
    const response = await fetch(url, { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error?.message || "订单状态暂不可用");
    if (generation !== state.generation) return;
    if (result.code) {
      clearTimers();
      state.code = result.code;
      $("#delivery-code").textContent = result.code;
      forget();
      showStage("done");
      return;
    }
    if (result.status === "delivered") {
      // 领取令牌已被用过（多半是刷新页面后重复领取）：卡密改由查订单页凭联系方式取回。
      clearTimers();
      forget();
      toast("本单领取链接已使用，请到查订单页取回");
      window.location.href = `./query?contact=${encodeURIComponent(state.order.contact || "")}`;
      return;
    }
    if (result.status === "expired") { expire(); return; }
    if (result.status === "processing") {
      $("#timer-state").textContent = "核验支付中";
      if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    }
  } catch {
    // 继续轮询：一次网络抖动不能把订单令牌丢掉。
  }
  if (generation === state.generation && state.order && !state.expired) {
    state.pollTimer = setTimeout(() => poll(generation), POLL_MS);
  }
}

/** 回到第一步。必须把提示文案复位，否则回去看到的还是「正在分配订单尾数…」。 */
function backToSetup() {
  reset();
  lock(false);
  const hint = $("#form-hint");
  hint.textContent = "密码不可逆保存，忘记只能凭付款记录联系售后。";
  hint.classList.remove("is-error");
  showStage("setup");
}

/* ---------- 装配 ---------- */

document.querySelectorAll("[data-plan]").forEach((button) => button.addEventListener("click", () => { if (!state.locked) setPlan(button.dataset.plan); }));
document.querySelectorAll("[data-method]").forEach((button) => button.addEventListener("click", () => { if (!state.locked) setMethod(button.dataset.method); }));
$("#order-form").addEventListener("submit", (event) => { event.preventDefault(); createOrder(); });
$("#restart").addEventListener("click", backToSetup);
$("#retry").addEventListener("click", backToSetup);
$("#copy-code").addEventListener("click", async () => {
  if (!state.code) return;
  try {
    await navigator.clipboard.writeText(state.code);
    toast("激活码已复制");
  } catch {
    toast("请长按激活码手动复制");
  }
});
$("#qr-image").addEventListener("load", () => { $("#qr-image").hidden = false; });
$("#qr-image").addEventListener("error", () => {
  $("#qr-image").hidden = true;
  $("#qr-fallback").hidden = false;
});

setPlan(new URLSearchParams(window.location.search).get("plan") || "7");
setMethod("alipay");
loadStock();
// 尾数池只有 90 格且 2 分钟回收一次，档位会变得很快；但已经在付款的人不需要再看库存。
setInterval(() => { if (!state.locked) loadStock(); }, 30_000);

const restored = recall();
if (restored) {
  state.order = restored;
  setPlan(restored.planDays || state.plan);
  setMethod(restored.paymentMethod || state.method);
  $("#contact").value = restored.contact || "";
  lock(true);
  showOrder(restored);
  $("#timer-state").textContent = "继续等待支付";
  poll(state.generation);
}
