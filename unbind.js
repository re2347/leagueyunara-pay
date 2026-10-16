/* 自助解绑页脚本
 *
 * 三条不属于外观的约束，写在这里以免被后来者"顺手简化"：
 * 1) 解绑每天一次且不可撤销，所以按钮必须等勾选确认才放行，请求期间整张表单锁住——
 *    双击两次就是两次解绑（服务端有幂等冲突保护，但让用户看到"今天已用完"比看到冲突好）。
 * 2) 授权服务是主备双线，两条都实现了同一个路由。只在**传输层/5xx/响应不是 JSON**时换下一条；
 *    4xx 带着结构化 error.code 的是业务结论，必须原样呈现，换线路重问一遍
 *    只会把一个明确答案变成两个互相矛盾的答案。
 * 3) 激活码等同密码：成功后立刻清空输入框，结果卡里不出现码文；所有服务端回来的文字都走
 *    textContent，不拼 innerHTML。
 */

// 主备两条授权线路，两条都实现了同一个路由。买家页面上不出现供应商名字：这对他们是没有的
// 信息，而「哪条线在处理」本来就该由服务端的请求号去查，不该由页面替排查的人下结论。
const ENDPOINTS = [
  "https://kzqgphxrghdclkwneqyn.supabase.co/functions/v1/auth",
  "https://license.re2347.ccwu.cc",
];
const REQUEST_TIMEOUT_MS = 12_000;
const HEALTH_TIMEOUT_MS = 6_000;

const form = document.querySelector("#unbind-form");
const codeInput = document.querySelector("#license-code");
const codeError = document.querySelector("#code-error");
const confirmBox = document.querySelector("#unbind-confirm");
const submitButton = document.querySelector("#unbind-submit");
const resultPanel = document.querySelector("#result-panel");
const serviceState = document.querySelector("#service-state");
const toastEl = document.querySelector("#toast");

let pending = false;
let resetTimer = null;
let toastTimer = null;

const normalizeCode = (value) => value.replace(/[^a-z0-9]/gi, "").toUpperCase();

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
}

function setFieldError(message) {
  codeError.hidden = !message;
  codeError.textContent = message || "";
  codeInput.setAttribute("aria-invalid", message ? "true" : "false");
}

function beijingClock(seconds) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000));
}

function pad(part) {
  return String(part).padStart(2, "0");
}

/** 剩余时间用倒计时显示，绝对时刻一并写在小字里：只知道"还有 3 小时"的人仍然会错过。 */
function renderCountdown(targetSeconds, slot) {
  const tick = () => {
    const left = Math.max(0, targetSeconds - Math.floor(Date.now() / 1000));
    const hours = Math.floor(left / 3600);
    const minutes = Math.floor((left % 3600) / 60);
    const seconds = left % 60;
    slot.replaceChildren();
    if (left <= 0) {
      slot.append(document.createTextNode("00:00:00"));
      const after = document.createElement("small");
      after.textContent = "已到重置时刻，可以再试一次";
      slot.append(after);
      clearInterval(resetTimer);
      resetTimer = null;
      return;
    }
    slot.append(document.createTextNode(`${pad(hours)}:${pad(minutes)}:${pad(seconds)}`));
    const after = document.createElement("small");
    after.textContent = `后（北京时间 ${beijingClock(targetSeconds)} 重置）`;
    slot.append(after);
  };
  tick();
  resetTimer = setInterval(tick, 1000);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** 结果卡完全用节点拼出来：服务端的 message 是外部输入，绝不进 innerHTML。 */
function showResult({ tone, badge, title, copy, meta = [], actions = [], countdownAt = null }) {
  clearInterval(resetTimer);
  resetTimer = null;
  resultPanel.dataset.tone = tone;
  resultPanel.hidden = false;
  resultPanel.replaceChildren();

  const head = node("div", "result-head");
  head.append(node("span", "result-title", title), node("span", "badge", badge));
  resultPanel.append(head);

  const paragraph = node("p", "result-copy", copy);
  resultPanel.append(paragraph);

  if (countdownAt) {
    const clock = node("div", "reset-clock");
    renderCountdown(countdownAt, clock);
    resultPanel.append(clock);
  }

  if (meta.length) {
    const list = node("dl", "result-meta");
    for (const [key, value] of meta) {
      const wrap = node("div");
      wrap.append(node("dt", null, key), node("dd", null, value));
      list.append(wrap);
    }
    resultPanel.append(list);
  }

  if (actions.length) {
    const row = node("div", "result-actions");
    for (const [label, kind, handler] of actions) {
      const button = node("button", `button ${kind}`, label);
      button.type = "button";
      button.addEventListener("click", handler);
      row.append(button);
    }
    resultPanel.append(row);
  }
  resultPanel.tabIndex = -1;
  resultPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  // 键盘和读屏用户不会自动读到滚出屏幕的结果卡；焦点移过去比只挂 aria-live 可靠，
  // preventScroll 是为了让上面那次平滑滚动说了算，不要两个滚动打架。
  resultPanel.focus({ preventScroll: true });
}

/* 每个结论都自带下一步：`next` 决定结果卡上的主按钮——
 *   "input"：原样重发必然得到同一个答案，所以按钮是回到输入框改正；
 *   "again"：结论可能随时间变化（并发冲突、服务端故障），重发有意义；
 *   null：答案就是「等着」，不给按钮，免得买家以为多点几下能绕过每天一次。 */
const OUTCOMES = {
  INVALID_CODE: {
    tone: "bad", badge: "格式不对", title: "激活码格式无效", next: "input",
    copy: "激活码至少 16 位字母数字。请把整张码粘贴完整，短横线可省，但不能缺字符。",
  },
  LICENSE_NOT_FOUND: {
    tone: "bad", badge: "查无此码", title: "没有这张激活码", next: "input",
    copy: "通常是少打或多打了一位。核对后再提交一次；确认无误就带上请求号找群管。",
  },
  LICENSE_REVOKED: {
    tone: "bad", badge: "已撤销", title: "这张码已被撤销", next: "input",
    copy: "撤销一般因为退款或违规使用，自助解绑不能恢复它。想换一张码请重新购买。",
  },
  LICENSE_EXPIRED: {
    tone: "bad", badge: "已过期", title: "这张激活码已经过期", next: "input",
    copy: "过期的授权不能释放后再利用。想确认它到底什么时候到期，去「查订单」按联系方式找回。",
  },
  LICENSE_NOT_BOUND: {
    tone: "warn", badge: "无需解绑", title: "这张码当前没有绑定中的设备", next: "input",
    copy: "可能已经解绑过，或者旧设备早就自己掉线了。这种情况下不必做任何操作，直接在新电脑上用同一张码激活即可。",
  },
  SELF_UNBIND_DAILY_LIMIT: {
    tone: "warn", badge: "今天用过了", title: "每天只能自助解绑一次", next: null,
    copy: "等倒计时结束再回来即可。如果确实一天内需要解绑两台不同的设备，只能人工处理：带请求号找群管。",
  },
  DEVICE_UNBIND_CONFLICT: {
    tone: "warn", badge: "状态变了", title: "绑定状态刚刚变化", next: "again",
    copy: "可能有另一台设备同时在激活或解绑。等几秒再提交一次；仍然冲突就先去新电脑激活试一下。",
  },
  DEVICE_UNBIND_FAILED: {
    tone: "bad", badge: "未完成", title: "解绑没有成功", next: "again",
    copy: "服务端已回滚，绑定关系保持原样，今天这次不算次数。稍后重试；反复失败请联系群管。",
  },
  SERVICE_UNREACHABLE: {
    tone: "bad", badge: "连不上", title: "授权服务没有回应", next: "again",
    copy: "先确认本机网络，再重试一次。持续不通通常是服务端在维护，这种情况下人工也解不了，请稍后再来。",
  },
};

function outcomeFor(code, serverMessage) {
  const known = OUTCOMES[code];
  if (known) return known;
  return {
    tone: "bad", badge: "失败", title: serverMessage || "解绑没有完成", next: "again",
    copy: "这个错误不在预期里。带上请求号找群管，比截图更快定位。",
  };
}

function setBusy(busy) {
  pending = busy;
  submitButton.disabled = busy || !confirmBox.checked;
  submitButton.textContent = busy ? "正在处理" : "解绑旧设备";
  codeInput.readOnly = busy;
  confirmBox.disabled = busy;
}

async function postUnbind(api, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${api}/v1/self-service/unbind`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId() },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    return { api, response, result };
  } catch {
    return { api, response: null, result: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 换线路的判据只有「这次请求根本没被回答」：传输失败、超时、非 JSON、408、5xx。 */
function shouldFallOver(response, result) {
  if (!response || !result) return true;
  return response.status >= 500 || response.status === 408;
}

async function submitUnbind(code) {
  let last = null;
  for (const api of ENDPOINTS) {
    const attempt = await postUnbind(api, code);
    last = attempt;
    if (!shouldFallOver(attempt.response, attempt.result)) break;
  }
  return last;
}

function renderSuccess(attempt) {
  const { result } = attempt;
  const nextResetAt = Number(result.nextResetAt) || 0;
  showResult({
    tone: "ok", badge: "已解绑", title: "旧设备已经释放",
    copy: "现在可以在新电脑上用这张激活码直接激活，不需要重新购买。旧电脑下次联网校验时会退出授权。",
    meta: [["请求号", result.requestId || "--"]],
    countdownAt: nextResetAt || null,
    actions: [
      ["复制请求号", "button-quiet", () => copyText(result.requestId || "")],
      ["再解绑一张码", "button-quiet", resetForm],
    ],
  });
}

function renderFailure(attempt) {
  const { result, response } = attempt;
  if (!result || typeof result !== "object") {
    showResult({ ...OUTCOMES.SERVICE_UNREACHABLE, meta: [], countdownAt: null, actions: [["再试一次", "button-quiet", submitAgain]] });
    return;
  }
  const code = result.error?.code || `HTTP_${response ? response.status : "0"}`;
  const outcome = outcomeFor(code, result.error?.message);
  const nextResetAt = Number(result.nextResetAt) || 0;
  const meta = [["请求号", result.requestId || "--"]];
  if (!nextResetAt) meta.push(["错误码", code]);
  const actions = [];
  if (outcome.next === "again") actions.push(["再试一次", "button-quiet", submitAgain]);
  if (outcome.next === "input") actions.push(["回到输入框", "button-quiet", focusCode]);
  if (result.requestId) actions.push(["复制请求号", "button-quiet", () => copyText(result.requestId)]);
  showResult({ ...outcome, meta, countdownAt: nextResetAt || null, actions });
}

function copyText(value) {
  if (!value) { toast("没有可复制的内容"); return; }
  navigator.clipboard.writeText(value).then(
    () => toast("请求号已复制"),
    () => toast("浏览器不允许复制，请长按选中"),
  );
}

function resetForm() {
  codeInput.value = "";
  codeInput.readOnly = false;
  confirmBox.checked = false;
  resultPanel.hidden = true;
  resultPanel.replaceChildren();
  setBusy(false);
  codeInput.focus();
}

function validateAndSubmit() {
  if (pending) return;
  const raw = codeInput.value.trim();
  const normalized = normalizeCode(raw);
  if (normalized.length < 16) {
    setFieldError("请输入完整激活码（至少 16 位字母数字）");
    codeInput.focus();
    return;
  }
  if (!confirmBox.checked) {
    setFieldError("");
    toast("请先勾选确认");
    return;
  }
  setFieldError("");
  setBusy(true);
  resultPanel.hidden = true;
  submitUnbind(raw).then((attempt) => {
    setBusy(false);
    if (attempt.result?.ok) {
      // 成功后清空码文：这台机器可能不是买家自己的，页面也不该替他留着凭据。
      codeInput.value = "";
      confirmBox.checked = false;
      renderSuccess(attempt);
      return;
    }
    renderFailure(attempt);
  });
}

function submitAgain() {
  validateAndSubmit();
}

/** 结论是「码不对」时，重发同一串只会得到同一句答复；把光标放回输入框并选中，改一位就能提交。 */
function focusCode() {
  codeInput.focus();
  codeInput.select();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  validateAndSubmit();
});

confirmBox.addEventListener("change", () => {
  submitButton.disabled = pending || !confirmBox.checked;
});

/**
 * 按 4 位一组补短横线：卡密的分组就是买家最容易看漏的地方，少打一组时眼睛很难发现，
 * 分好组的串一眼就能看出短了一截。光标位置按「前面数到第几个字母数字」还原，
 * 否则每敲一个字符光标就被甩到末尾，中间改错字会变成折磨。
 */
function formatCode(value) {
  return normalizeCode(value).slice(0, 64).replace(/(.{4})(?=.)/g, "$1-");
}

function caretIndex(el) {
  const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
  return normalizeCode(el.value.slice(0, start)).length;
}

function placeCaret(el, alnumCount) {
  if (alnumCount <= 0) {
    el.setSelectionRange(0, 0);
    return;
  }
  let seen = 0;
  for (let index = 0; index < el.value.length; index += 1) {
    if (!/[a-z0-9]/i.test(el.value[index])) continue;
    seen += 1;
    if (seen >= alnumCount) {
      el.setSelectionRange(index + 1, index + 1);
      return;
    }
  }
  el.setSelectionRange(el.value.length, el.value.length);
}

codeInput.addEventListener("input", () => {
  const caret = caretIndex(codeInput);
  const formatted = formatCode(codeInput.value);
  if (formatted !== codeInput.value) {
    codeInput.value = formatted;
    placeCaret(codeInput, caret);
  }
  if (!codeError.hidden) setFieldError("");
});

/** 解绑不可撤销，而请求号是事后找回这张码唯一的人工凭据：请求在飞的时候别让人一划走就没了。 */
window.addEventListener("beforeunload", (event) => {
  if (!pending) return;
  event.preventDefault();
  event.returnValue = "";
});

/**
 * 先问一句服务是否健康，让买家在提交之前就知道"是页面不通还是我的码不通"。
 * 探活失败只把灯变灰，绝不拦住表单——某个 /health 没部署而解绑能用是常见情形，
 * 把它变成门禁反而会做出一个打不开也点不动的页面。
 */
async function probeService() {
  serviceState.textContent = "服务自检中";
  for (const api of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${api}/health`, { signal: controller.signal });
      if (response.ok) {
        serviceState.textContent = "服务正常";
        serviceState.dataset.state = "ok";
        return;
      }
    } catch {
      /* 换下一条 */
    } finally {
      clearTimeout(timer);
    }
  }
  serviceState.textContent = "服务未响应";
  serviceState.dataset.state = "down";
}

probeService();
