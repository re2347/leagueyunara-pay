/* 首屏主题与侧栏状态：必须在首次绘制前落到 <html> 上，否则会先闪一下浅色、
   再闪一下展开态。页面 CSP 是 script-src 'self'，所以这段只能是独立文件。
   键名与后台 theme.js 分开（后台用 yunara.admin.theme），互不干扰。 */
(function () {
  var root = document.documentElement;
  var THEME_KEY = "yunara.pay.theme";
  var SIDER_KEY = "yunara.pay.sider";

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var theme = read(THEME_KEY);
  if (theme !== "dark" && theme !== "light") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-sider", read(SIDER_KEY) === "collapsed" ? "collapsed" : "expanded");
})();
