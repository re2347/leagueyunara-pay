/* 买家三页共用的外壳行为：主题、侧栏折叠/抽屉、选中游标、FAQ、复制金额。
 *
 * 分工要划清楚：这一层**只管外观与导航**，付款、查单、解绑的业务逻辑全部留在
 * pay.js / query.js / unbind.js 里，它们一行都不被这里改动。所以这里：
 *   · 不 fetch 任何东西；
 *   · 不读写那三个脚本的 state；
 *   · 只观察 DOM 上已经发生的变化（aria-checked / hidden），把游标跟上去。
 *
 * 页面 CSP 是 script-src 'self'，没有内联脚本；需要按数据改的样式一律走 CSSOM。
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var THEME_KEY = "yunara.pay.theme";
  var SIDER_KEY = "yunara.pay.sider";

  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); }

  function readStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function writeStore(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式只是失去记忆 */ } }

  /* ------------------------------------------------------------ Toast 复用
     那三个业务脚本各自带一份 toast 实现，这里不抢它们的话筒：需要提示时用同一个
     #toast 节点、同一套 class，谁先写谁生效，互不覆盖生命周期。 */
  var shellToastTimer = null;
  function say(message) {
    var el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(shellToastTimer);
    shellToastTimer = setTimeout(function () { el.classList.remove("is-visible"); }, 2400);
  }

  function copyText(value, okMessage) {
    if (!value) { say("没有可复制的内容"); return; }
    var done = function () { say(okMessage || "已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, function () { say("浏览器不允许复制，请长按选中"); });
      return;
    }
    say("浏览器不支持自动复制，请长按选中");
  }

  /* ------------------------------------------------------------ 主题 */
  function applyTheme(theme, persist) {
    root.setAttribute("data-theme", theme);
    var button = $("#theme-toggle");
    if (button) {
      var dark = theme === "dark";
      button.setAttribute("aria-checked", String(dark));
      var glyph = $(".theme-toggle__glyph", button);
      var label = $(".theme-toggle__text", button);
      if (glyph) glyph.textContent = dark ? "☀" : "☾";
      if (label) label.textContent = dark ? "浅色模式" : "深色模式";
    }
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0e0e11" : "#f5f6f7");
    if (persist) writeStore(THEME_KEY, theme);
    // 深浅色换了之后药丸的可见度不同，游标重新量一次最省事。
    requestAnimationFrame(syncAllSegs);
  }

  function initTheme() {
    var button = $("#theme-toggle");
    applyTheme(readStore(THEME_KEY) === "dark" || readStore(THEME_KEY) === "light" ? readStore(THEME_KEY) : (root.getAttribute("data-theme") || "light"), false);
    if (!button) return;
    button.addEventListener("click", function () {
      applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true);
    });
  }

  /* ------------------------------------------------------------ 侧栏 */
  function syncMenuCursor() {
    var menu = $(".sider__menu");
    var cursor = $(".menu-cursor");
    var active = $(".menu-item.is-active");
    if (!menu || !cursor) return;
    if (!active) { cursor.style.height = "0px"; return; }
    var box = menu.getBoundingClientRect();
    var item = active.getBoundingClientRect();
    cursor.style.height = item.height + "px";
    cursor.style.transform = "translateY(" + Math.round(item.top - box.top) + "px)";
  }

  function setCollapsed(collapsed, persist) {
    root.setAttribute("data-sider", collapsed ? "collapsed" : "expanded");
    if (persist) writeStore(SIDER_KEY, collapsed ? "collapsed" : "expanded");
    requestAnimationFrame(function () { syncMenuCursor(); syncAllSegs(); });
  }

  function initSider() {
    setCollapsed(readStore(SIDER_KEY) === "collapsed", false);

    var collapse = $("#sider-collapse");
    if (collapse) {
      collapse.addEventListener("click", function () {
        setCollapsed(root.getAttribute("data-sider") !== "collapsed", true);
      });
    }

    var toggle = $("#nav-toggle");
    var sider = $("#sidebar");
    var scrim = $("#scrim");
    function setDrawer(open) {
      if (!sider) return;
      sider.classList.toggle("is-open", open);
      if (scrim) scrim.classList.toggle("is-on", open);
      if (toggle) toggle.setAttribute("aria-expanded", String(open));
    }
    if (toggle && sider) {
      toggle.addEventListener("click", function () { setDrawer(!sider.classList.contains("is-open")); });
    }
    if (scrim) scrim.addEventListener("click", function () { setDrawer(false); });
    if (sider) $$(".menu-item", sider).forEach(function (link) { link.addEventListener("click", function () { setDrawer(false); }); });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") setDrawer(false); });

    window.addEventListener("resize", function () { syncMenuCursor(); syncAllSegs(); syncFaqHeights(); });
    requestAnimationFrame(syncMenuCursor);
    // 中文字体是异步就绪的，行高变了游标就要重量，否则首屏游标会偏一两像素。
    setTimeout(syncMenuCursor, 260);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncMenuCursor).catch(function () { /* 忽略 */ });
  }

  /* ------------------------------------------------------------ 分段控件游标
     那三个业务脚本自己改 aria-checked，这里不去接管点击，只观察结果并把药丸推过去。 */
  function syncSeg(seg) {
    var cursor = $(".seg__cursor", seg);
    if (!cursor) return;
    var active = $('.seg__item[aria-checked="true"]', seg);
    if (!active || active.hidden) { cursor.style.setProperty("--w", "0px"); return; }
    var box = seg.getBoundingClientRect();
    var item = active.getBoundingClientRect();
    if (!item.width) { cursor.style.setProperty("--w", "0px"); return; }
    cursor.style.setProperty("--x", Math.round(item.left - box.left - 4) + "px");
    cursor.style.setProperty("--w", Math.round(item.width) + "px");
  }

  function syncAllSegs() { $$("[data-seg]").forEach(syncSeg); }

  function initSegs() {
    if (!$$(".seg__cursor").length) return;
    syncAllSegs();
    requestAnimationFrame(syncAllSegs);
    setTimeout(syncAllSegs, 300);

    // aria-checked 变了、或所在 stage 被隐藏/显示，都可能让药丸错位。
    var observer = new MutationObserver(function () { syncAllSegs(); });
    $$("[data-seg]").forEach(function (seg) {
      observer.observe(seg, { attributes: true, attributeFilter: ["aria-checked"], subtree: true });
    });
    var stages = $$("[data-stage]");
    if (stages.length) {
      var stageObserver = new MutationObserver(function () { syncAllSegs(); syncMenuCursor(); });
      stages.forEach(function (stage) { stageObserver.observe(stage, { attributes: true, attributeFilter: ["hidden"] }); });
    }
  }

  /* ------------------------------------------------------------ FAQ */
  function openPanel(question, open) {
    var panel = question.nextElementSibling;
    question.setAttribute("aria-expanded", String(open));
    if (panel) panel.style.height = open ? panel.firstElementChild.offsetHeight + "px" : "0px";
  }

  function syncFaqHeights() {
    $$(".faq__q[aria-expanded='true']").forEach(function (question) {
      var panel = question.nextElementSibling;
      if (panel && panel.firstElementChild) panel.style.height = panel.firstElementChild.offsetHeight + "px";
    });
  }

  function initFaq() {
    $$("[data-faq]").forEach(function (group) {
      group.addEventListener("click", function (event) {
        var question = event.target.closest ? event.target.closest(".faq__q") : null;
        if (!question) return;
        var willOpen = question.getAttribute("aria-expanded") !== "true";
        $$(".faq__q", group).forEach(function (other) { if (other !== question) openPanel(other, false); });
        openPanel(question, willOpen);
      });
    });
  }

  /* ------------------------------------------------------------ 复制金额
     pay.js 只负责把「￥20.13」写进 #pay-amount，页面上这颗复制按钮是纯前端便利，
     读的就是那个元素已有的文本，不碰它的订单状态。 */
  function initCopyAmount() {
    var button = $("#copy-amount");
    var source = $("#pay-amount");
    if (!button || !source) return;
    button.addEventListener("click", function () {
      var raw = (source.textContent || "").replace(/[^\d.]/g, "");
      if (!raw) { say("还没有生成订单金额", true); return; }
      copyText(raw, "金额 " + raw + " 已复制");
    });
  }

  function init() {
    initTheme();
    initSider();
    initSegs();
    initFaq();
    initCopyAmount();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
