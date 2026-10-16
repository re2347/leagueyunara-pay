const QUERY_CONFIG = {
  api: "https://kzqgphxrghdclkwneqyn.supabase.co/functions/v1/auth",
};

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
    const response = await fetch(`${QUERY_CONFIG.api}/v1/orders/query`, {
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
    const response = await fetch(`${QUERY_CONFIG.api}/v1/orders/reveal`, {
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
