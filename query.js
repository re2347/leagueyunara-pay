const QUERY_CONFIG = {
  // 与购买视图同一套加速优先级：SCF 香港是主通道（唯一同时覆盖 /v1/orders/* 与授权的节点），
  // Supabase 直连第二，CF Worker 兜底。查单没有写操作，多一次 failover 只是慢，不会重复扣款。
  endpoints: [
    "https://1476066536-elj6sayzy3.ap-hongkong.tencentscf.com",
    "https://kzqgphxrghdclkwneqyn.supabase.co/functions/v1/auth",
    "https://pay-api.re2347.ccwu.cc",
  ],
};

/** 单个端点的请求上限，与 pay.js 对齐：10 秒，容得下 SCF 的冷启动（详见 pay.js 同名常量的注释）。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 记住上次成功的端点下标，后续请求优先复用它，不必每次都从主通道重探。 */
let activeEndpoint = 0;

/**
 * 端点故障转移。判据与 pay.js 的 request() 完全一致：只在「网络层失败」和「5xx」时换下一条；
 * 4xx 带着结构化 error.code 的是业务结论（密码错、订单不存在），换线路只会把同一个答案再问一遍，
 * 白花一次跨境请求。这里刻意不 import pay.js —— query.js 既作为 module 进合并页，
 * 也作为 classic 脚本进转发页 query.html，加 import 会让后者直接报错。
 */
async function request(path, init) {
  const endpoints = QUERY_CONFIG.endpoints;
  let lastError = null;
  let networkError = null;
  for (let attempt = 0; attempt < endpoints.length; attempt += 1) {
    const index = (activeEndpoint + attempt) % endpoints.length;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoints[index] + path, { ...init, signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (response.status >= 500 && attempt < endpoints.length - 1) {
        lastError = new Error("查询服务暂不可用");
        continue;
      }
      activeEndpoint = index;
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (!networkError) networkError = error;
      lastError = error;
    }
  }
  throw networkError || lastError || new Error("查询服务暂不可用");
}

const statusLabels = { pending: "待支付", processing: "核验支付中", paid: "已支付", delivered: "已领取", expired: "已过期" };
const state = { orders: [], revealed: new Map(), credential: "" };

const $ = (selector) => document.querySelector(selector);
let toastTimer;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2600);
}

/** 联系方式是买家自己输入的字符串，会原样回到这一页；不转义就是自我 XSS 注入点。 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function formatTime(seconds) {
  const value = Number(seconds);
  if (!value) return "--";
  const date = new Date(value * 1000);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const isLocked = (order) => Number(order.lockedUntil || 0) * 1000 > Date.now();

async function queryOrders() {
  const credential = $("#query-input").value.trim();
  const results = $("#results");
  if (!credential) {
    results.innerHTML = '<p class="empty">请输入下单时留的邮箱、手机号或订单号。</p>';
    return;
  }
  state.credential = credential;
  state.revealed.clear();
  results.innerHTML = '<p class="empty">正在查询…</p>';
  try {
    const response = await request("/v1/orders/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error?.message || "查询服务暂不可用");
    state.orders = result.orders || [];
    render(result.matchedBy);
  } catch (error) {
    state.orders = [];
    results.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function render(matchedBy) {
  const results = $("#results");
  if (!state.orders.length) {
    results.innerHTML = `<p class="empty">没有找到与「${escapeHtml(state.credential)}」相关的订单。${matchedBy === "contact" ? "请确认这里填的是下单时留的邮箱或手机号。" : ""}</p>`;
    return;
  }
  results.innerHTML = state.orders.map((order) => {
    const id = escapeHtml(order.orderId);
    const revealed = state.revealed.get(order.orderId);
    const lock = isLocked(order) ? '<span class="badge is-warn">密码错误过多，已锁定</span>' : "";
    const action = revealed
      ? `<div class="reveal-code">${escapeHtml(revealed)}</div>`
      : order.codeAvailable
        ? `<div class="reveal">
            <label class="sr-only" for="pw-${id}">查询密码</label>
            <input id="pw-${id}" type="password" autocomplete="off" placeholder="输入查询密码" data-input="${id}" />
            <button type="button" data-reveal="${id}">查看</button>
          </div>`
        : `<p class="empty">${order.status === "pending" ? `请按 ${escapeHtml(order.amountYuan || "--")} 元完成付款，激活码会自动发放。` : "该订单没有可显示的激活码。"}</p>`;
    return `<article class="order">
      <div class="order-head">
        <span class="order-title">${escapeHtml(order.productName || `${order.planDays} 天`)}</span>
        <span class="badge">${escapeHtml(statusLabels[order.status] || order.status || "未知")}</span>${lock}
      </div>
      <dl class="order-meta">
        <div><dt>金额</dt><dd>${escapeHtml(order.amountYuan ? `${order.amountYuan} 元` : "--")}</dd></div>
        <div><dt>下单</dt><dd>${escapeHtml(formatTime(order.createdAt))}</dd></div>
        <div><dt>支付</dt><dd>${escapeHtml(formatTime(order.paidAt))}</dd></div>
        <div><dt>订单号</dt><dd class="mono">${id}</dd></div>
      </dl>
      ${action}
    </article>`;
  }).join("");
}

async function revealOrder(orderId, password) {
  try {
    const response = await request("/v1/orders/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId, queryPassword: password }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error?.message || "验证服务暂不可用");
    if (!result.code) {
      toast("该订单尚未发放激活码");
      return;
    }
    state.revealed.set(orderId, result.code);
    render("contact");
    try {
      await navigator.clipboard.writeText(result.code);
      toast("激活码已复制");
    } catch {
      toast("激活码已显示，请手动复制");
    }
  } catch (error) {
    toast(error.message);
    // 连续输错会触发按订单锁定；重新拉一次让锁定状态立刻可见，而不是靠猜。
    if (/锁定|过多/.test(error.message || "")) queryOrders();
  }
}

$("#query-form").addEventListener("submit", (event) => { event.preventDefault(); queryOrders(); });

$("#results").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reveal]");
  if (!button) return;
  const input = document.querySelector(`[data-input="${CSS.escape(button.dataset.reveal)}"]`);
  const password = (input?.value || "").trim();
  if (!password) { toast("请输入查询密码"); return; }
  revealOrder(button.dataset.reveal, password);
});

$("#results").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.matches("[data-input]")) return;
  event.preventDefault();
  const password = (event.target.value || "").trim();
  if (!password) { toast("请输入查询密码"); return; }
  revealOrder(event.target.dataset.input, password);
});

const prefill = new URLSearchParams(window.location.search).get("contact");
if (prefill) {
  $("#query-input").value = prefill;
  queryOrders();
}
