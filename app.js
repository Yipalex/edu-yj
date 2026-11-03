/* SSO_TOKEN_CATCH：接收工作台「切换系统」跳转携带的令牌，写入本地登录态 */
try { const _ssoTk = new URLSearchParams(location.search).get('tk'); if (_ssoTk) { localStorage.setItem('zb_token', _ssoTk); history.replaceState(null, '', location.pathname + (location.hash || '')); } } catch (_) {}
/* 泽曦书画·课时提成智能登记系统 - 核心逻辑 */
'use strict';

/* 版本自纠：HTML 与 JS 版本不一致（旧缓存混搭）时强制带新参数刷新一次 */
const APP_VER = '20261102h';
if (window.__ZX_VER && window.__ZX_VER !== APP_VER && !/__r=/.test(location.search)) {
  location.replace(location.pathname + '?__r=' + Date.now() + location.hash);
}

/* ========== 云服务初始化 ========== */
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: '',
  app: 'yj',
});
const db = cloud.database;

/* ========== 常量 ========== */
const CAMPUSES = ['金城校区', '霞山校区', '海东校区', '麻章校区', '开发区校区'];
const COURSES = ['硬笔书法', '毛笔书法', '美术', '硬笔书法精英班'];
/* 课后服务地址兜底列表（正式数据在 service_addrs 表，超管在「账号管理」维护；表不可用时用此兜底） */
const DEFAULT_SERVICE_ADDRS = ['24小', '岭南接送园', '京学', '奥海城', '蓝海峰镜', '御景名城', '兆兴', '布朗之星', '海小', '培才', '华盛新城', '霞山二中', '36小', '美德堡', '国雅', '28中', '嘉庆苑', '33小', '京基', '岭南师范附中', '麻章实验小'];
const TYPES = {
  course:  { name: '课时打卡',     ico: ZXShell.icon('clock'), desc: '填时间课程+人数' },
  tuition: { name: '学费登记',     ico: ZXShell.icon('coins'), desc: '收据金额提成' },
  goods:   { name: '物品销售',     ico: ZXShell.icon('box'), desc: '扫条码选物品' },
  invite:  { name: '邀约试听',     ico: ZXShell.icon('phone'), desc: '体验课登记' },
  other_income: { name: '其他收入', ico: ZXShell.icon('card'), desc: '不计提成业绩' },
  summary: { name: '校区月度汇总', ico: ZXShell.icon('chart'), desc: '校区月度业绩' },
};
const STATUS = {
  pending:   { name: '待财务审核', cls: 'pending' },
  accounted: { name: '财务已核算', cls: 'accounted' },
  returned:  { name: '有疑问退回', cls: 'returned' },
};
const ROLE_NAMES = { staff: '填报人', leader: '管理', finance: '财务' };

/* 鉴权角色体系（users.role，超管在账号管理中分配）：教师/教务、校长、财务、超级管理员 */
const ROLES = { teacher: '教师/教务', principal: '校长', finance: '财务', superadmin: '超级管理员' };
function myRole() { return (state.session && state.session.user && state.session.user.role) || 'teacher'; }
function canSummary() { return ['principal', 'finance', 'superadmin'].includes(myRole()); }
function canFinance() { return ['principal', 'finance', 'superadmin'].includes(myRole()); }
/* 指定超管账号（仅此手机号）：可彻底删除任意记录（含已核算），前后端双重限制 */
const ERASER_PHONE = '18507599754';
function canErase() { return !!(state.session && state.session.user && state.session.user.phone === ERASER_PHONE); }

/* ========== 全局状态 ========== */
const state = {
  session: null, profile: null,
  classes: [], items: [], addrs: null,
  teachers: [],   /* 在职教师名单（学费登记「授课老师」下拉，/api/yj/teachers） */
  systemAccess: null, /* 六系统权限缓存（key -> {access, sso, url}），顶栏切换器拦截用 */
  textModel: null, imageModel: null,
};

/* ========== 工具 ========== */
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function thisMonth() { return today().slice(0, 7); }
function fmtDT(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : ''; }
function unwrap({ data, error }) { if (error) throw error; return data; }

/* 账号管理后台接口封装（超管专属，token 走 localStorage zb_token） */
async function apiAdmin(path, opts = {}) {
  const token = localStorage.getItem('zb_token') || '';
  const headers = { Authorization: 'Bearer ' + token };
  const init = { method: opts.method || 'GET', headers };
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  const res = await fetch('/api/yj' + path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.message || (data.error && data.error.message))) || ('HTTP ' + res.status));
  return data;
}
function isSuper() { return !!(state.session && state.session.user && state.session.user.role === 'superadmin'); }

/* ========== 教师名单 & 消息未读数 ========== */
async function loadTeachers() {
  try {
    const d = await apiAdmin('/teachers');
    state.teachers = (d && d.teachers) || [];
  } catch (e) { state.teachers = []; }
}
async function refreshUnread() {
  if (!state.session) return;
  try {
    const d = await apiAdmin('/messages/unread-count');
    const n = (d && d.count) || 0;
    if (zxShellReady && window.ZXShell && ZXShell.setBadge) ZXShell.setBadge('messages', n || '');
  } catch (e) { /* 静默：消息服务不可用时不影响主流程 */ }
}

function pageShell(title, inner, opts = {}) {
  const showBack = opts.back !== false;
  app.innerHTML = `
    <div class="pg-head">
      ${showBack ? '<a class="pg-back" href="javascript:history.back()">‹ 返回</a>' : ''}
      <h2>${esc(title)}</h2>
    </div>
    <div class="page">${inner}</div>`;
}
async function logout() {
  if (!confirm('确定退出登录？')) return;
  await cloud.auth.signOut();
  state.session = null; state.profile = null;
  location.reload();
}

/* ========== 统一骨架（墨·纸·印 shell） ========== */
const ZX_SYSTEMS = [
  { id: 'yj',   name: '业绩登记系统', domain: 'yj.zexishuhua.com',   color: 'var(--zx-sys-yj)',   url: 'https://yj.zexishuhua.com/' },
  { id: 'quan', name: '券类管理系统', domain: 'quan.zexishuhua.com', color: 'var(--zx-sys-quan)', url: 'https://quan.zexishuhua.com/' },
  { id: 'jz',   name: '教资报名系统', domain: 'jz.zexishuhua.com',   color: 'var(--zx-sys-jz)',   url: 'https://jz.zexishuhua.com/' },
  { id: 'sf',   name: '评测报告系统', domain: 'sf.zexishuhua.com',   color: 'var(--zx-sys-sf)',   url: 'https://sf.zexishuhua.com/' },
  { id: 'wms',  name: '仓库管理系统', domain: 'wms.zexishuhua.com',  color: 'var(--zx-sys-wms)',  url: 'https://wms.zexishuhua.com/' },
  { id: 'zc',   name: '固定资产管理', domain: 'zc.zexishuhua.com',   color: 'var(--zx-sys-zc)',   url: 'https://zc.zexishuhua.com/' },
];
const YJ_NAV = [
  { group: '', items: [
    { id: 'home', icon: 'home', label: '工作台', href: '#/home' },
    { id: 'mine', icon: 'report', label: '我的业绩', href: '#/mine' },
    { id: 'rank', icon: 'chart', label: '业绩榜单', href: '#/rank' },
    { id: 'switch', icon: 'card', label: '切换系统', href: '#/switch' },
    { id: 'messages', icon: 'bell', label: '消息', href: '#/messages' },
  ]},
  { group: '登记', items: [
    { id: 'new-course', icon: 'clock', label: '课时打卡', href: '#/new/course' },
    { id: 'new-tuition', icon: 'coins', label: '学费登记', href: '#/new/tuition' },
    { id: 'new-goods', icon: 'box', label: '物品销售', href: '#/new/goods' },
  ]},
  { group: '管理', items: [
    { id: 'approve', icon: 'audit', label: '审核中心', href: '#/approve', roles: ['principal', 'finance', 'superadmin'] },
    { id: 'finance', icon: 'chart', label: '财务报表', href: '#/finance', roles: ['principal', 'finance', 'superadmin'] },
    { id: 'summary', icon: 'calendar', label: '月度汇总', href: '#/new/summary', roles: ['principal', 'finance', 'superadmin'] },
  ]},
  { group: '系统', items: [
    { id: 'admin', icon: 'users', label: '账号与权限', href: '#/admin', roles: ['superadmin'] },
    { id: 'logs', icon: 'log', label: '操作日志', href: '#/logs', roles: ['superadmin'] },
  ]},
];
let zxShellReady = false;
function ensureShell() {
  if (zxShellReady || !state.profile) return;
  zxShellReady = true;
  ZXShell.init({
    brand: { name: '泽曦工作台', logo: null },
    systems: ZX_SYSTEMS,
    currentSystem: 'yj',
    nav: YJ_NAV,
    tabbar: ['home', 'mine', 'rank', 'switch', 'messages'],
    user: { name: state.profile.name, role: ROLES[myRole()] || ROLE_NAMES[state.profile.role] || '', roleType: myRole() },
    activeNav: '',
    onLogout: logout,
  });
  bindSystemGuard();
}
function syncShellNav(hash) {
  if (!zxShellReady) return;
  let id = '';
  if (hash === '#/home' || hash === '#/') id = 'home';
  else if (hash === '#/mine') id = 'mine';
  else if (hash === '#/messages') id = 'messages';
  else if (hash === '#/rank') id = 'rank';
  else if (hash === '#/switch') id = 'switch';
  else if (hash === '#/approve') id = 'approve';
  else if (hash === '#/finance') id = 'finance';
  else if (hash === '#/admin') id = 'admin';
  else if (hash === '#/logs') id = 'logs';
  else if (hash.startsWith('#/new/')) id = 'new-' + hash.slice(6);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('is-active', a.getAttribute('data-nav') === id);
  });
}

/* ========== 消息中心 ========== */
const MSG_KIND = {
  xibao:      { name: '喜报',   cls: 'accounted' },
  xibao_fail: { name: '推送失败', cls: 'returned' },
  xibao_skip: { name: '待配置',  cls: 'pending' },
  returned:   { name: '退回',   cls: 'returned' },
  info:       { name: '通知',   cls: 'pending' },
};
async function renderMessages() {
  pageShell('消息', '<div class="loading-box">加载中…</div>');
  let list = [];
  try {
    const d = await apiAdmin('/messages');
    list = (d && d.messages) || [];
  } catch (e) {
    pageShell('消息', `<div class="empty">加载失败：${esc(e.message)}</div>`);
    return;
  }
  await apiAdmin('/messages/read-all', { method: 'POST' }).catch(() => {});
  refreshUnread();
  const html = list.length ? list.map((m) => {
    const k = MSG_KIND[m.kind] || MSG_KIND.info;
    return `<div class="rec">
      <div class="rhead"><span class="rtype">${esc(k.name)}</span><span class="badge ${k.cls}">${m.read ? '已读' : '未读'}</span></div>
      <div class="rmain"><b>${esc(m.title || '')}</b><br>${esc(m.body || '')}</div>
      <div class="rmeta">${fmtDT(m.created_at)}</div>
    </div>`;
  }).join('') : '<div class="empty">暂无消息<br><span class="muted" style="font-size:12px">学费核算通过、喜报推送结果、记录退回都会在这里通知你</span></div>';
  pageShell('消息', html);
}

/* ========== 路由 ========== */
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash || '#/home';
  if (!state.session) { renderLogin(); return; }
  if (!state.profile) { renderOnboarding(); return; }
  ensureShell();
  syncShellNav(hash);
  if (hash.startsWith('#/new/')) return renderNew(hash.slice(6));
  if (hash === '#/home' || hash === '#/') return renderHome();
  if (hash.startsWith('#/mine')) return renderMine(hash);
  if (hash === '#/messages') return renderMessages();
  if (hash === '#/rank') return renderRank();
  if (hash === '#/switch') return renderSwitch();
  if (hash === '#/approve') return renderApprove();
  if (hash === '#/finance') return renderFinance();
  if (hash === '#/params') return renderParams();
  if (hash === '#/ai-test') return renderAiTest();
  if (hash === '#/admin') return renderAdmin();
  if (hash === '#/logs') return renderLogs();
  renderHome();
}

/* ========== 启动 ========== */
async function boot() {
  const d = await cloud.auth.getSession();
  const session = (d && d.data && d.data.session) || null;
  state.session = session;
  if (session) {
    try {
      const rows = unwrap(await db.from('profiles').select('*').eq('owner_id', session.user.id).limit(1));
      state.profile = rows[0] || null;
    } catch (e) { state.profile = null; }
    if (state.profile) {
      loadBaseData(); loadModels(); loadTeachers(); refreshUnread(); loadSystemAccess();
      if (!state._unreadTimer) state._unreadTimer = setInterval(refreshUnread, 60_000);
    }
  }
  route();
  checkReturnedAndAlert();
}
cloud.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') { state.session = null; state.profile = null; location.hash = '#/home'; route(); }
});

/* ========== 登录 / 注册（手机号 + 密码） ========== */
function renderLogin(mode) {
  const isReg = mode === 'register';
  app.innerHTML = `
    <div class="login-hero">
      <div class="seal-mark">泽</div>
      <h1>泽曦工作台</h1>
      <p>泽曦书画 · 老师中心 —— 随手记，不攒到月底。截图 / 说话 / 点几下，都能记。</p>
    </div>
    <div class="login-form">
      <div class="field">
        <label>手机号</label>
        <input id="lg-phone" type="tel" maxlength="11" placeholder="请输入 11 位手机号" inputmode="numeric">
        <div class="field-err" id="lg-phone-err"></div>
      </div>
      ${isReg ? `
      <div class="field">
        <label>姓名</label>
        <input id="lg-name" placeholder="真实姓名（与工资表一致）">
      </div>` : ''}
      <div class="field">
        <label>密码</label>
        <input id="lg-password" type="password" placeholder="${isReg ? '设置密码（至少 6 位）' : '请输入密码'}">
      </div>
      ${isReg ? `
      <div class="field">
        <label>确认密码</label>
        <input id="lg-password2" type="password" placeholder="再次输入密码">
      </div>` : ''}
      <button class="btn" id="lg-submit">${isReg ? '注册并登录' : '登 录'}</button>
      <p class="hint" style="text-align:center;margin-top:14px">
        ${isReg
          ? '已有账号？<a href="javascript:void 0" id="lg-toggle" style="color:var(--blue)">返回登录</a>'
          : '首次使用？<a href="javascript:void 0" id="lg-toggle" style="color:var(--blue)">注册账号</a>（仅限本机构员工使用）'}
      </p>
    </div>`;
  $('#lg-phone').addEventListener('input', () => { $('#lg-phone-err').textContent = ''; });
  $('#lg-toggle').addEventListener('click', () => renderLogin(isReg ? 'login' : 'register'));
  $('#lg-submit').addEventListener('click', isReg ? submitRegister : submitPasswordLogin);
}
async function submitPasswordLogin() {
  const phone = $('#lg-phone').value.trim();
  const password = $('#lg-password').value;
  if (!/^1\d{10}$/.test(phone)) { $('#lg-phone-err').textContent = '请输入正确的 11 位手机号'; return; }
  if (!password) { toast('请输入密码'); return; }
  $('#lg-submit').disabled = true;
  const r = await cloud.auth.signInWithPassword({ phone, password });
  $('#lg-submit').disabled = false;
  if (r.error) { toast('登录失败：' + r.error.message); return; }
  state.loginPhone = phone;
  await afterLogin();
}
async function submitRegister() {
  const phone = $('#lg-phone').value.trim();
  const name = $('#lg-name').value.trim();
  const password = $('#lg-password').value;
  const password2 = $('#lg-password2').value;
  if (!/^1\d{10}$/.test(phone)) { $('#lg-phone-err').textContent = '请输入正确的 11 位手机号'; return; }
  if (!name) { toast('请填写姓名'); return; }
  if (password.length < 6) { toast('密码至少 6 位'); return; }
  if (password !== password2) { toast('两次输入的密码不一致'); return; }
  $('#lg-submit').disabled = true;
  let r = await cloud.auth.signUp({ phone, password, name });
  if (r.error) { $('#lg-submit').disabled = false; toast('注册失败：' + r.error.message); return; }
  if (!(r.data && r.data.token)) {
    /* 注册响应未带 token 时再用密码登录一次 */
    r = await cloud.auth.signInWithPassword({ phone, password });
    $('#lg-submit').disabled = false;
    if (r.error) { toast('注册成功，请登录：' + r.error.message); renderLogin('login'); return; }
  } else {
    $('#lg-submit').disabled = false;
  }
  state.loginPhone = phone;
  toast('注册成功');
  await afterLogin();
}
async function afterLogin() {
  state.session = (await cloud.auth.getSession()).data.session;
  if (!state.session) { toast('登录状态异常，请重试'); renderLogin(); return; }
  const rows = unwrap(await db.from('profiles').select('*').eq('owner_id', state.session.user.id).limit(1));
  state.profile = rows[0] || null;
  if (state.profile) {
    loadBaseData(); loadModels(); loadTeachers(); refreshUnread(); loadSystemAccess();
    if (!state._unreadTimer) state._unreadTimer = setInterval(refreshUnread, 60_000);
  }
  route();
  checkReturnedAndAlert();
}

/* ========== 首次登录：完善资料 ========== */
function renderOnboarding() {
  app.innerHTML = `
    <div class="login-hero"><div class="seal-mark">泽</div><h1>完善个人信息</h1><p>仅首次登录需要，用于标识你填报的记录</p></div>
    <div class="login-form">
      <div class="field"><label>姓名 <span class="req">*</span></label>
        <input id="ob-name" placeholder="真实姓名（与工资表一致）"></div>
      <div class="field"><label>所属校区 <span class="req">*</span></label>
        <select id="ob-campus">${CAMPUSES.map((c) => `<option>${c}</option>`).join('')}</select></div>
      <button class="btn" id="ob-submit">开始使用</button>
    </div>`;
  $('#ob-submit').addEventListener('click', async () => {
    const name = $('#ob-name').value.trim();
    if (!name) { toast('请填写姓名'); return; }
    const btn = $('#ob-submit'); btn.disabled = true;
    try {
      const su = (state.session && state.session.user) || {};
      const phone = String(state.loginPhone || su.phone || su.phone_number || '').replace(/^\+86\s*/, '').trim();
      let role = 'staff';
      if (phone) {
        try {
          const presets = unwrap(await db.from('role_presets').select('*').eq('phone', phone).limit(1)) || [];
          if (presets[0] && presets[0].role) role = presets[0].role;
        } catch (e) { /* 预分配查询失败按默认角色 */ }
      }
      const rows = unwrap(await db.from('profiles').insert({ name, campus: $('#ob-campus').value, phone: phone || null, role }).select());
      state.profile = rows[0];
      if (role !== 'staff') toast('已为你开通「' + (ROLE_NAMES[role] || role) + '」角色');
      loadBaseData(); loadModels();
      location.hash = '#/home'; route();
    } catch (e) {
      toast('保存失败：' + (e.message || '网络异常'));
      btn.disabled = false;
    }
  });
}

/* ========== 基础数据 ========== */
async function loadBaseData() {
  try { state.items = unwrap(await db.from('items').select('*').order('barcode')) || []; } catch (e) { state.items = []; }
  fetchAddrs();
}
/* 在售物品名录：过滤已停用项（status='deprecated'，WMS 名录中已不存在的旧记录，仅保留存档不删除） */
function activeItems() { return (state.items || []).filter((it) => it.status !== 'deprecated'); }
/* 课后服务地址：从 service_addrs 表拉取；force=true 强制刷新（超管增删后调用）。
   表不存在/查询失败时用 DEFAULT_SERVICE_ADDRS 兜底，保证登记页可用。返回 [{id,name}] */
async function fetchAddrs(force) {
  if (!force && state.addrs) return state.addrs;
  try {
    const rows = unwrap(await db.from('service_addrs').select('id,name').order('sort').order('id')) || [];
    state.addrs = rows;
  } catch (e) {
    if (!state.addrs) state.addrs = DEFAULT_SERVICE_ADDRS.map((name, i) => ({ id: null, name, sort: i + 1 }));
  }
  return state.addrs;
}
function addrNames() {
  const rows = state.addrs || DEFAULT_SERVICE_ADDRS.map((name, i) => ({ id: null, name, sort: i + 1 }));
  return rows.map((r) => (r && typeof r === 'object' ? r.name : r));
}
/* 回填课后服务地址：下拉里没有该值时先补一个 option（兼容历史地址已从列表删除的情况） */
function setAddrSelect(v) {
  const el = $('#f-addr');
  if (!el || !v) return;
  if (!Array.from(el.options).some((o) => o.value === v || o.textContent === v)) {
    const op = document.createElement('option');
    op.textContent = v;
    el.appendChild(op);
  }
  el.value = v;
}
async function loadModels() {
  try {
    const models = await cloud.llm.models.list();
    const usable = (models || []).filter((m) => m.disabled !== true);
    state.textModel = usable[0] || null;
    state.imageModel = usable.find((m) => m.supportsImages === true) || null;
  } catch (e) { /* 模型不可用时 AI 功能自动隐藏 */ }
}

/* ========== 首页 ========== */
/* 金额展示：过万用 w */
function fmtMoney(v) {
  const n = Number(v) || 0;
  return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(Math.round(n));
}
function fmtYuan(v) { return '¥' + Math.round(Number(v) || 0).toLocaleString('zh-CN'); }

async function renderHome() {
  const p = state.profile;
  pageShell('工作台', '<div class="loading-box">加载中…</div>', { back: false, tab: 'home' });
  let st = null, tgt = { target: 15000 };
  try { st = await apiAdmin('/my-stats'); } catch (e) { /* 统计失败不阻断首页 */ }
  try { tgt = await apiAdmin('/my-target'); } catch (e) {}

  const entries = Object.entries(TYPES)
    .filter(([k]) => k !== 'summary' || canSummary())
    .map(([k, t]) => `<a class="entry" href="#/new/${k}"><div class="eico">${t.ico}</div><div class="ename">${t.name}</div><div class="edesc">${t.desc}</div></a>`).join('');

  let dash = '';
  if (st) {
    const maxT = Math.max(...st.trend.map((t) => t.amount), 1);
    const bars = st.trend.map((t) => {
      const h = Math.max(Math.round((t.amount / maxT) * 100), t.amount > 0 ? 6 : 2);
      return `<div class="trend-col" title="${t.month}：${fmtYuan(t.amount)}"><div class="trend-bar" style="height:${h}%;${t.month === st.month ? 'background:var(--zx-accent,#B03A2A)' : ''}"></div><div class="trend-v">${fmtMoney(t.amount)}</div><div class="trend-m">${t.month.slice(5)}月</div></div>`;
    }).join('');
    const pct = tgt.target > 0 ? Math.min(100, Math.round((st.amount / tgt.target) * 100)) : 0;
    const badgeDef = [
      ['order_king', '🏆', '开单王', '本月开单数全校第一'],
      ['full_att', '⭐', '满勤之星', '本月每天都有登记记录'],
      ['invite_star', '📣', '邀约之星', '本月邀约体验全校第一'],
    ];
    const badges = badgeDef.map(([k, ico, name, desc]) => {
      const on = st.badges && st.badges[k];
      return `<div class="badge-card${on ? ' on' : ''}"><div class="badge-ico">${ico}</div><div class="badge-name">${name}</div><div class="badge-desc">${desc}</div>${on ? '<div class="badge-tag">已获得</div>' : '<div class="badge-tag off">未获得</div>'}</div>`;
    }).join('');
    dash = `
    <div class="sec-title">${st.month.replace('-', ' 年 ')} 月 · 我的战绩</div>
    <div class="stat-grid">
      <a class="stat-card" href="#/mine?type=tuition"><div class="stat-num">${fmtMoney(st.amount)}</div><div class="stat-label">本月业绩（元）</div></a>
      <a class="stat-card" href="#/mine?type=tuition"><div class="stat-num">${st.orders}</div><div class="stat-label">本月开单</div></a>
      <a class="stat-card" href="#/mine?type=course"><div class="stat-num">${st.hours}</div><div class="stat-label">本月课时</div></a>
      <a class="stat-card" href="#/mine?type=invite"><div class="stat-num">${st.invites}</div><div class="stat-label">本月邀约</div></a>
    </div>
    <div class="card">
      <h3>月度目标进度</h3>
      <div class="target-row"><span>${fmtYuan(st.amount)}</span><span class="muted">目标 ${fmtYuan(tgt.target)}</span></div>
      <div class="target-bar"><div class="target-fill" style="width:${pct}%"></div></div>
      <div class="muted" style="margin-top:6px">${pct >= 100 ? '🎉 已达标，继续冲！' : `已完成 ${pct}%${st.rank ? ` · 全校第 ${st.rank} 名` : ''}`}</div>
    </div>
    <div class="card">
      <h3>近 6 个月业绩趋势</h3>
      <div class="trend">${bars}</div>
      <div class="muted" style="margin-top:6px">按有效单（已提交+已核算，退回除外）、跟进老师归属统计</div>
    </div>
    <div class="sec-title">成就徽章</div>
    <div class="badge-grid">${badges}</div>`;
  }

  pageShell('工作台', `
    ${dash}
    <div class="sec-title">记一笔</div>
    <div class="entry-grid">${entries}</div>
    <div class="card hint">
      把本页「添加到主屏幕」（浏览器分享菜单里），以后点桌面图标一步直达，不用进企业微信找。
    </div>
    ${isSuper() ? `
    <div class="sec-title">系统管理</div>
    <div class="card" style="text-align:center;">
      <a href="#/admin" style="display:inline-block;padding:12px 18px;border:1px solid #d0d0d0;border-radius:8px;color:#333;text-decoration:none;">👤 账号管理（开通 / 停用 / 删除 / 重置密码）</a>
    </div>` : ''}
  `, { back: false, tab: 'home' });
}

/* ========== 业绩榜单（教师仅本人+名次，避免攀比；校长看本校区；超管/财务看全校+校区汇总） ========== */
async function renderRank() {
  pageShell('业绩榜单', '<div class="loading-box">加载中…</div>');
  let d;
  try { d = await apiAdmin('/rank'); }
  catch (e) { pageShell('业绩榜单', `<div class="empty">加载失败：${esc(e.message)}</div>`); return; }
  const s = d.self || {};
  const medal = (i) => ['🥇', '🥈', '🥉'][i] || (i + 1);
  const monthTxt = d.month.replace('-', ' 年 ') + ' 月';

  const topTable = (rows, emptyTxt) => rows && rows.length
    ? `<table class="tbl"><thead><tr><th>名次</th><th>老师</th><th style="text-align:right">业绩</th><th style="text-align:right">单数</th></tr></thead>
       <tbody>${rows.map((r, i) => `<tr><td>${medal(i)}</td><td>${esc(r.name)}</td><td style="text-align:right"><b>${fmtYuan(r.amount)}</b></td><td style="text-align:right">${r.orders}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${emptyTxt}</div>`;

  // 校长：本校区汇总 + 校区教师榜；超管/财务：全校区汇总条形图 + 全校 TOP10
  let scopeHtml = '';
  if (d.role === 'principal') {
    const cs = (d.campusSummary || [])[0];
    scopeHtml = `
    <div class="sec-title">${monthTxt} · ${esc(d.campus || '本校区')}汇总</div>
    ${cs ? `<div class="stat-grid">
      <div class="stat-card"><div class="stat-num">${fmtMoney(cs.amount)}</div><div class="stat-label">校区业绩（元）</div></div>
      <div class="stat-card"><div class="stat-num">${cs.orders}</div><div class="stat-label">校区开单</div></div>
      <div class="stat-card"><div class="stat-num">${cs.hours}</div><div class="stat-label">校区课时</div></div>
    </div>` : `<div class="card hint">未查到本校区数据。</div>`}
    <div class="sec-title">${esc(d.campus || '本校区')}教师榜（有效单）</div>
    <div class="card">${topTable(d.campusRank, '本校区本月还没有有效业绩')}</div>`;
  } else if (d.role === 'manager') {
    const maxC = Math.max(...(d.campusSummary || []).map((c) => c.amount), 1);
    const bars = (d.campusSummary || []).map((c) => {
      const w = Math.max(Math.round((c.amount / maxC) * 100), c.amount > 0 ? 4 : 1);
      return `<div class="camp-row"><div class="camp-name">${esc(c.campus)}</div>
        <div class="camp-bar-wrap"><div class="camp-bar" style="width:${w}%"></div></div>
        <div class="camp-v">${fmtYuan(c.amount)} · ${c.orders}单 · ${c.hours}课时</div></div>`;
    }).join('');
    scopeHtml = `
    <div class="sec-title">${monthTxt} · 全校区汇总（有效单）</div>
    <div class="card">${bars || '<div class="empty">本月暂无校区业绩数据</div>'}</div>
    <div class="sec-title">${monthTxt} · 全校 TOP 榜</div>
    <div class="card">${topTable(d.top, '本月暂无有效业绩')}</div>`;
  }

  pageShell('业绩榜单', `
    <div class="sec-title">${monthTxt} · 我的位置</div>
    <div class="card" style="text-align:center;">
      <div style="font-size:34px;font-weight:700;color:var(--zx-accent,#B03A2A)">${s.rank ? '第 ' + s.rank + ' 名' : '暂无排名'}</div>
      <div class="muted">${s.total ? `全校共 ${s.total} 位老师有业绩` : '本月还没有有效业绩'}</div>
      <div style="margin-top:12px;display:flex;justify-content:center;gap:32px">
        <div><div style="font-size:20px;font-weight:600">${fmtYuan(s.amount || 0)}</div><div class="muted">我的业绩</div></div>
        <div><div style="font-size:20px;font-weight:600">${s.orders || 0} 单</div><div class="muted">我的开单</div></div>
      </div>
    </div>
    ${scopeHtml || `<div class="card hint">全校榜单仅管理角色（校长 / 财务 / 超管）可见，避免攀比争议。</div>`}
  `);
}

/* ========== 系统切换（六系统收纳；无权限锁定置灰 + 联系 IT） ========== */
async function renderSwitch() {
  pageShell('切换系统', '<div class="loading-box">加载中…</div>');
  let systems = [];
  try { systems = (await apiAdmin('/systems')).systems || []; }
  catch (e) { pageShell('切换系统', `<div class="empty">加载失败：${esc(e.message)}</div>`); return; }
  const token = (() => { try { return localStorage.getItem('zb_token') || ''; } catch (_) { return ''; } })();
  const cards = systems.map((s) => {
    const mine = s.key === 'yj';
    const disabled = s.access === 'denied';
    const href = mine ? 'javascript:;' : (s.sso && s.access === 'granted' && token ? s.url + '?tk=' + encodeURIComponent(token) + '#/home' : s.url);
    return `<a class="sys-card${disabled ? ' locked' : ''}" data-key="${s.key}" href="${href}" ${disabled ? 'data-locked="1"' : ''}>
      <div class="sys-name">${esc(s.name)}${mine ? ' <span class="badge">当前</span>' : ''}${s.access === 'login' ? ' <span class="badge warn">需单独登录</span>' : ''}</div>
      <div class="sys-desc">${esc(s.desc)}</div>
      ${disabled ? '<div class="sys-lock">🔒 无权限 · 联系 IT 管理员开通</div>' : ''}
    </a>`;
  }).join('');
  pageShell('切换系统', `
    <div class="card hint">六套系统一处跳转：已授权系统免登录直达（同一账号），固定资产与仓库为独立账号。</div>
    <div class="sys-grid">${cards}</div>
    <div class="card" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
      <span>需要开通系统权限？</span>
      <button class="btn" id="sw-contact" type="button">联系 IT 管理员</button>
    </div>
  `);
  document.querySelectorAll('.sys-card[data-locked]').forEach((a) => {
    a.addEventListener('click', (ev) => { ev.preventDefault(); toast('暂无该系统权限，请联系 IT 管理员开通'); });
  });
  const c = $('#sw-contact');
  if (c) c.onclick = () => { toast('请把「姓名+手机号+要开通的系统」发给 IT 管理员'); };
}

/* ========== 顶栏系统切换器守卫：无权限拦截（PC 顶部提示条 / 手机底部弹层）+ SSO 补令牌 ========== */
async function loadSystemAccess() {
  try {
    const d = await apiAdmin('/systems');
    state.systemAccess = {};
    (d.systems || []).forEach((s) => { state.systemAccess[s.key] = s; });
  } catch (e) { state.systemAccess = null; }
}
let sysGuardBound = false;
function bindSystemGuard() {
  if (sysGuardBound) return;
  sysGuardBound = true;
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('.zx-sys-switch__item');
    if (!a) return;
    const items = Array.from(document.querySelectorAll('.zx-sys-switch__item'));
    const sys = ZX_SYSTEMS[items.indexOf(a)];
    if (!sys) return;
    const acc = state.systemAccess && state.systemAccess[sys.id];
    if (acc && acc.access === 'denied') {
      ev.preventDefault(); ev.stopPropagation();
      showLockedTip(sys.name);
      return;
    }
    if (acc && acc.sso && acc.access === 'granted' && sys.id !== 'yj') {
      const tk = (() => { try { return localStorage.getItem('zb_token') || ''; } catch (_) { return ''; } })();
      if (tk && !/[?&]tk=/.test(a.href)) a.href = acc.url + '?tk=' + encodeURIComponent(tk) + '#/home';
    }
  }, true);
}
function showLockedTip(name) {
  const old = document.querySelector('.zx-lock-tip'); if (old) old.remove();
  const tip = document.createElement('div');
  tip.className = 'zx-lock-tip';
  tip.innerHTML = `<span>🔒 <b>${esc(name)}</b> 暂无权限，请联系 IT 管理员开通</span>`;
  document.body.appendChild(tip);
  requestAnimationFrame(() => tip.classList.add('show'));
  setTimeout(() => { tip.classList.remove('show'); setTimeout(() => tip.remove(), 350); }, 3200);
}

/* ========== AI 模型自检 ========== */
async function renderAiTest() {
  pageShell('AI 模型自检', `
    <div class="card">
      <h3>大模型连通性测试</h3>
      <p class="muted">用于在配置或更换 .env 中的 LLM API Key 后验证连通是否正常。文本模型用于"语音速记"，视觉模型用于"截图识别"。</p>
    </div>
    <div class="card" style="margin-top:12px;">
      <button id="btn-test-all" class="primary" style="width:100%;padding:12px;">一键测试全部</button>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="btn-test-text" style="flex:1;padding:10px;">仅测文本模型</button>
        <button id="btn-test-vision" style="flex:1;padding:10px;">仅测视觉模型</button>
      </div>
    </div>
    <div id="ai-test-result" style="margin-top:12px;"></div>
  `, { back: true, tab: '' });

  const $res = $('#ai-test-result');
  const runTest = async (kind) => {
    $res.innerHTML = '<div class="card">测试中…请稍候（最长 15 秒）</div>';
    try {
      const resp = await fetch('/api/yj/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('zb_token') || '') },
        body: JSON.stringify({ kind }),
      });
      const data = await resp.json();
      const items = Object.entries(data).map(([k, r]) => {
        const tag = r.ok ? '<span style="color:#2e7d32;">✓ 正常</span>' : '<span style="color:#c62828;">✗ 异常</span>';
        const detail = r.ok
          ? `<div class="muted">模型: ${esc(r.model)} · 回复: ${esc(r.reply || '')}</div>`
          : `<div class="muted">原因: ${esc(r.error || '')}</div>`;
        const conf = r.configured === false ? '<div class="muted" style="color:#e65100;">未配置 key，请先在 .env 填写</div>' : '';
        return `<div class="card" style="margin-top:8px;"><h4>${k === 'text' ? '文本模型' : '视觉模型'} ${tag}</h4>${conf}${detail}</div>`;
      }).join('');
      $res.innerHTML = items || '<div class="card">无结果</div>';
    } catch (e) {
      $res.innerHTML = `<div class="card" style="color:#c62828;">请求失败：${esc(e.message)}</div>`;
    }
  };
  $('#btn-test-all').onclick = () => runTest('all');
  $('#btn-test-text').onclick = () => runTest('text');
  $('#btn-test-vision').onclick = () => runTest('vision');
}

/* ========== 账号管理（超管专属） ========== */
async function renderAdmin() {
  if (!isSuper()) { toast('仅超级管理员可访问'); location.hash = '#/home'; route(); return; }
  pageShell('账号管理', '<div class="loading-box">加载中…</div>', { back: true, tab: '' });
  let users = [];
  try {
    const d = await apiAdmin('/admin/users');
    users = d.users || [];
  } catch (e) {
    pageShell('账号管理', `<div class="empty">加载失败：${esc(e.message)}</div>`, { back: true, tab: '' });
    return;
  }
  const meId = state.session.user.id;
  let addrs = [];
  try { addrs = await fetchAddrs(true); } catch (e) { addrs = addrNames().map((name, i) => ({ id: null, name, sort: i + 1 })); }
  const roleBadge = (r) => `<span class="badge role-${esc(r)}">${esc(ROLES[r] || r)}</span>`;
  const rows = users.map((u) => {
    const isMe = String(u.id) === String(meId);
    const roleCell = isMe ? roleBadge(u.role)
      : `<select class="role-set" data-id="${esc(u.id)}" style="padding:6px 8px;border:1px solid var(--zx-line);border-radius:8px;font-size:13px;background:#fff;">
          ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>`;
    const stB = u.active ? '<span class="badge accounted">启用</span>' : '<span class="badge returned">已停用</span>';
    const ops = [];
    if (!isMe) {
      ops.push(`<button class="btn sm" data-act="access" data-id="${esc(u.id)}">系统权限</button>`);
      ops.push(`<button class="btn sm" data-act="reset" data-id="${esc(u.id)}">重置密码</button>`);
      ops.push(u.active
        ? `<button class="btn sm ghost" data-act="disable" data-id="${esc(u.id)}">停用</button>`
        : `<button class="btn sm" data-act="enable" data-id="${esc(u.id)}">启用</button>`);
      ops.push(`<button class="btn sm red" data-act="del" data-id="${esc(u.id)}">删除</button>`);
    } else {
      ops.push('<span class="muted">当前账号</span>');
    }
    return `<tr>
      <td>${esc(u.phone)}</td><td>${esc(u.name)}</td><td>${roleCell}</td><td>${stB}</td>
      <td>${fmtDT(u.created_at)}</td><td class="ops" style="min-width:280px;">${ops.join(' ')}</td>
    </tr>`;
  }).join('');
  const html = `
    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:600;margin-bottom:8px;">课后服务地址管理</div>
      <div id="addr-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        ${addrs.map((a) => a.id == null
          ? `<span style="display:inline-block;padding:3px 10px;border:1px dashed #c0c0c0;border-radius:14px;font-size:13px;color:#888;">${esc(a.name)}</span>`
          : `<span style="display:inline-flex;align-items:center;gap:2px;padding:3px 4px 3px 10px;border:1px solid #d0d0d0;border-radius:14px;font-size:13px;">${esc(a.name)}<button type="button" data-addr-del="${esc(a.id)}" data-addr-name="${esc(a.name)}" title="删除该地址" style="border:none;background:#fdecea;color:#c62828;border-radius:50%;width:18px;height:18px;line-height:16px;cursor:pointer;font-size:13px;padding:0;">×</button></span>`).join('') || '<span class="muted">暂无地址</span>'}
      </div>
      <div style="display:flex;gap:8px;">
        <input id="addr-new" placeholder="新地址名称，如：麻章实验小" style="flex:1;padding:8px 10px;border:1px solid #d0d0d0;border-radius:8px;font-size:14px;">
        <button class="btn sm" id="addr-add">添加</button>
      </div>
      <p class="muted" style="margin-top:8px;font-size:12px;">「课时打卡」的课后服务下拉选项在此维护，保存后所有教师立即生效；删除只影响新登记，历史记录里已选的地址不受影响。</p>
    </div>
    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:600;margin-bottom:8px;">月度业绩目标配置（按自然月）</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;white-space:nowrap;">全校默认目标（元/月）</span>
        <input id="tg-default" type="number" min="0" step="100" inputmode="numeric" style="width:120px;padding:6px 8px;border:1px solid #d0d0d0;border-radius:8px;font-size:14px;">
      </div>
      <div id="tg-users" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 12px;margin-bottom:10px;"></div>
      <button class="btn sm" id="tg-save">保存目标配置</button>
      <p class="muted" style="margin-top:8px;font-size:12px;">个人目标留空 = 跟随全校默认。目标用于工作台首页「月度目标进度条」（阶段二上线），仅本人与超管可见。</p>
    </div>
    <div class="card" style="margin-bottom:12px;">
      <button class="btn primary" id="admin-create">＋ 开通新账号</button>
      <p class="muted" style="margin-top:8px;font-size:12px;">开通：设置手机号、姓名与初始密码（默认为教师/教务角色）。「角色」列可直接切换：教师/教务（登记）、校长（登记+校区月度汇总+财务全部可见，除账号管理）、财务（除账号管理外全部）、超级管理员（全部+本页）。停用后该账号无法登录；删除仅移除登录账号，其历史登记记录会保留。<br>⚠️ 角色变更后需对方<b>退出重新登录</b>才生效。</p>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>手机号</th><th>姓名</th><th>角色（点击切换）</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted" style="text-align:center;">暂无账号</td></tr>'}</tbody>
    </table></div>`;
  pageShell('账号管理', html, { back: true, tab: '' });
  $('#admin-create').onclick = onAdminCreate;
  /* 月度目标配置：加载 + 保存 */
  (async () => {
    let cfg = { target: 15000, perUser: {} };
    try { cfg = await apiAdmin('/settings/target'); } catch (e) {}
    $('#tg-default').value = cfg.target != null ? cfg.target : 15000;
    $('#tg-users').innerHTML = users.filter((u) => u.active).map((u) => `
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px;">${esc(u.name)}</span>
        <input data-tg-uid="${esc(u.id)}" type="number" min="0" step="100" placeholder="默认"
          value="${cfg.perUser && cfg.perUser[u.id] != null ? esc(cfg.perUser[u.id]) : ''}"
          style="flex:1;min-width:70px;padding:5px 8px;border:1px solid #d0d0d0;border-radius:8px;font-size:13px;">
      </label>`).join('') || '<span class="muted" style="font-size:12px;">暂无在职账号</span>';
  })();
  $('#tg-save').onclick = async () => {
    const perUser = {};
    document.querySelectorAll('[data-tg-uid]').forEach((inp) => {
      const v = inp.value.trim();
      if (v !== '') perUser[inp.dataset.tgUid] = Number(v);
    });
    try {
      await apiAdmin('/settings/target', { method: 'PUT', json: { default: Number($('#tg-default').value) || 0, perUser } });
      toast('目标配置已保存');
    } catch (e) { toast('保存失败：' + (e.message || '网络异常')); }
  };
  $('#addr-add').onclick = onAddrAdd;
  document.querySelectorAll('[data-addr-del]').forEach((b) => { b.onclick = () => onAddrDel(b.dataset.addrDel, b.dataset.addrName); });
  document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => onAdminAct(b.dataset.act, b.dataset.id); });
  document.querySelectorAll('.role-set').forEach((sel) => {
    sel.onchange = () => onAdminRole(sel.dataset.id, sel.value);
  });
}

async function onAddrAdd() {
  const name = ($('#addr-new') && $('#addr-new').value || '').trim();
  if (!name) { toast('请输入地址名称'); return; }
  try {
    unwrap(await db.from('service_addrs').insert({ name, sort: (state.addrs ? state.addrs.length : 0) + 1 }));
    toast('已添加：' + name);
    await fetchAddrs(true);
    renderAdmin();
  } catch (e) { toast('添加失败：' + (e && e.message ? e.message : e)); }
}

async function onAddrDel(id, name) {
  if (!confirm(`确定删除「${name}」？删除后新登记不能再选它，历史记录不受影响。`)) return;
  try {
    unwrap(await db.from('service_addrs').delete().eq('id', Number(id)));
    toast('已删除：' + name);
    await fetchAddrs(true);
    renderAdmin();
  } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e)); }
}

async function onAdminRole(id, role) {
  const label = ROLES[role] || role;
  try {
    await apiAdmin(`/admin/users/${id}/role`, { method: 'POST', json: { role } });
    toast('角色已设为「' + label + '」，对方退出重新登录后生效');
  } catch (e) {
    toast('设置失败：' + e.message);
    renderAdmin();
  }
}

async function onAdminCreate() {
  const phone = prompt('开通账号 · 手机号（11 位）');
  if (!phone) return;
  if (!/^1\d{10}$/.test(phone.trim())) { toast('手机号格式不正确'); return; }
  const name = prompt('姓名');
  if (!name || !name.trim()) { toast('请填写姓名'); return; }
  const pwd = prompt('设置初始密码（至少 6 位）');
  if (!pwd || pwd.length < 6) { toast('密码至少 6 位'); return; }
  try {
    await apiAdmin('/admin/users', { method: 'POST', json: { phone: phone.trim(), name: name.trim(), password: pwd } });
    toast('已开通账号：' + phone.trim());
    renderAdmin();
  } catch (e) { toast('开通失败：' + e.message); }
}

async function onAdminAct(act, id) {
  if (act === 'access') return openAccessModal(id);
  try {
    if (act === 'reset') {
      const pwd = prompt('重置该账号初始密码（至少 6 位）');
      if (!pwd || pwd.length < 6) { toast('密码至少 6 位'); return; }
      await apiAdmin(`/admin/users/${id}/reset-password`, { method: 'POST', json: { password: pwd } });
      toast('密码已重置');
    } else if (act === 'disable') {
      if (!confirm('确定停用该账号？停用后对方将无法登录。')) return;
      await apiAdmin(`/admin/users/${id}/disable`, { method: 'POST' });
      toast('已停用');
    } else if (act === 'enable') {
      await apiAdmin(`/admin/users/${id}/enable`, { method: 'POST' });
      toast('已启用');
    } else if (act === 'del') {
      if (!confirm('确定删除该账号？该账号将无法再登录，但其历史登记记录会保留。')) return;
      await apiAdmin(`/admin/users/${id}`, { method: 'DELETE' });
      toast('已删除');
    }
    renderAdmin();
  } catch (e) { toast('操作失败：' + e.message); }
}

/* 系统权限弹窗：勾选可访问的系统并各自设定角色（统一账号体系） */
async function openAccessModal(id) {
  let info;
  try { info = await apiAdmin(`/admin/users/${id}/access`); }
  catch (e) { toast('读取失败：' + e.message); return; }
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;';
  wrap.innerHTML = `
    <div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.2);">
      <div style="font-weight:700;font-size:16px;margin-bottom:4px;">系统权限</div>
      <p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.6;">勾选后，该账号可用<b>同一手机号+密码</b>登录对应系统；取消勾选即停用其在对应系统的登录（业务数据保留）。角色默认按工作台角色给出，可单独调整。</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
        ${Object.entries(info.systems).map(([key, s]) => `
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e0dcd4;border-radius:10px;cursor:pointer;">
            <input type="checkbox" data-sys="${esc(key)}" ${info.access.includes(key) ? 'checked' : ''}>
            <span style="flex:1;font-size:14px;font-weight:600;">${esc(s.name)}</span>
            <select data-role="${esc(key)}" style="padding:5px 8px;border:1px solid #d0d0d0;border-radius:8px;font-size:13px;background:#fff;">
              ${s.roles.map(([k, v]) => `<option value="${esc(k)}" ${(info.roles[key] || info.defaults[key]) === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
            </select>
          </label>`).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn ghost" id="acc-cancel">取消</button>
        <button class="btn primary" id="acc-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  $('#acc-cancel').onclick = close;
  $('#acc-save').onclick = async () => {
    const access = [], roles = {};
    wrap.querySelectorAll('[data-sys]').forEach((cb) => {
      if (cb.checked) {
        access.push(cb.dataset.sys);
        roles[cb.dataset.sys] = wrap.querySelector(`[data-role="${cb.dataset.sys}"]`).value;
      }
    });
    try {
      const r = await apiAdmin(`/admin/users/${id}/access`, { method: 'PUT', json: { access, roles } });
      const fails = Object.entries(r.results || {}).filter(([, v]) => String(v).startsWith('fail'));
      close();
      toast(fails.length
        ? '已保存，但 ' + fails.map(([s, v]) => info.systems[s].name + '（' + v + '）').join('、') + ' 同步失败，请再试一次'
        : '已保存，对方可用同一手机号+密码登录所选系统');
      renderAdmin();
    } catch (e) { toast('保存失败：' + e.message); }
  };
}

/* ========== 操作日志（超管专属）：全量写操作留痕，保留 90 天 ========== */
const AUDIT_OP_NAMES = { insert: '新增', update: '修改', delete: '删除' };
const AUDIT_OP_COLORS = { insert: ['#e8f5e9', '#2e7d32'], update: ['#e3f2fd', '#1565c0'], delete: ['#fdecea', '#c62828'] };
/* 审计日志大白话映射（给不懂代码的人看） */
const AUDIT_TBL_NAMES = { records: '登记记录', profiles: '个人信息', params: '核算参数', items: '物品', service_addrs: '服务地点', months: '月份' };
const AUDIT_TYPE_NAMES = { course: '课时', tuition: '学费', goods: '物品销售', invite: '邀约体验', other_income: '其他收入', summary: '校区业绩' };
const AUDIT_STATUS_NAMES = { pending: '待审核', accounted: '已核算', returned: '已退回' };
const AUDIT_FIELD_NAMES = {
  status: '审核状态', campus: '校区', month: '所属月份', remark: '备注', type: '记录类型',
  course: '课程', date: '上课日期', start_time: '上课时间', end_time: '下课时间', attend: '上课人数',
  teach_role: '主教/助教', afterclass: '课后服务', service_addr: '服务地点',
  student: '学生姓名', amount: '金额', fee_type: '收费类型', receipt_no: '收据单号', pay_date: '缴费日期', commission_to: '提成归属',
  item_name: '物品名称', qty: '数量', barcode: '物品条码', teacher: '相关老师',
  trial_date: '体验日期', fee_name: '费用名称', phone: '联系电话', assist_for_name: '辅助主教',
};

/* 记录内容一句话简介：「课时 · 硬笔书法 10-20 19:00-20:30 · 8人 · 金城校区」 */
function auditRecordBrief(row) {
  if (!row || typeof row !== 'object') return '';
  const p = row.payload || {};
  const t = AUDIT_TYPE_NAMES[row.type] || row.type || '记录';
  const parts = [];
  if (p.course) parts.push(p.course);
  if (p.student) parts.push(p.student);
  if (p.item_name) parts.push(p.item_name);
  if (p.fee_name) parts.push(p.fee_name);
  if (p.date) parts.push(p.date);
  else if (p.pay_date) parts.push(p.pay_date);
  else if (p.trial_date) parts.push(p.trial_date);
  if (p.start_time && p.end_time) parts.push(`${p.start_time}-${p.end_time}`);
  if (p.attend !== undefined) parts.push(`${p.attend}人`);
  if (p.amount !== undefined) parts.push(`¥${p.amount}`);
  if (row.campus) parts.push(row.campus);
  if (AUDIT_STATUS_NAMES[row.status]) parts.push(`（${AUDIT_STATUS_NAMES[row.status]}）`);
  return parts.length ? `${t} · ${parts.join(' · ')}` : t;
}

function auditFmtVal(key, v) {
  if (v === null || v === undefined || v === '') return '（清空）';
  if (key === 'status') return AUDIT_STATUS_NAMES[v] || String(v);
  return String(v);
}

/* 把一条日志的 detail 翻译成大白话行（数组） */
function auditPlainLines(log) {
  const d = log.detail || {};
  const lines = [];
  if (log.op === 'insert') {
    const rows = (d.rows || []).filter(Boolean);
    if (rows.length) rows.forEach((r) => lines.push(`新增了记录：${auditRecordBrief(r)}`));
    else lines.push(`新增了${AUDIT_TBL_NAMES[log.tbl] || log.tbl || '记录'}`);
    return lines;
  }
  if (log.op === 'delete') {
    const rows = (d.deleted || []).filter(Boolean);
    if (rows.length) rows.forEach((r) => lines.push(`删除了记录：${auditRecordBrief(r)}`));
    else lines.push(log.record_id ? `删除了记录 #${log.record_id}` : '删除了记录');
    return lines;
  }
  if (log.op === 'update' && d.set) {
    const beforeRows = Array.isArray(d.before) ? d.before : [];
    const old = beforeRows[0] || {};
    const oldP = old.payload || {};
    const s = d.set;
    const typeName = AUDIT_TYPE_NAMES[old.type] || AUDIT_TBL_NAMES[log.tbl] || log.tbl || '记录';
    const head = beforeRows.length
      ? `修改了记录：${auditRecordBrief(old)}`
      : `修改了${typeName}记录${log.record_id ? ' #' + log.record_id : ''}`;
    lines.push(head);
    const diffLine = (key, ov, nv) => {
      if (nv === undefined) return;
      if (ov !== undefined && String(ov) === String(nv)) return; // 值没变不显示
      const label = AUDIT_FIELD_NAMES[key] || `字段 ${key}`;
      lines.push(ov !== undefined ? `${label}：${auditFmtVal(key, ov)} → ${auditFmtVal(key, nv)}`
        : `${label} 改为 ${auditFmtVal(key, nv)}`);
    };
    ['status', 'campus', 'month', 'type', 'remark'].forEach((k) => { if (s[k] !== undefined) diffLine(k, old[k], s[k]); });
    if (s.images !== undefined) lines.push('凭证/截图有更新');
    if (s.payload && typeof s.payload === 'object') {
      Object.keys(s.payload).forEach((k) => diffLine(k, oldP[k], s.payload[k]));
    }
    // 非 records 表（如核算参数）：兜底展示改动的字段
    if (log.tbl !== 'records' && s && typeof s === 'object') {
      Object.keys(s).forEach((k) => {
        if (['updated_at', 'status', 'campus', 'month', 'type', 'remark', 'images', 'payload'].includes(k)) return;
        if (AUDIT_FIELD_NAMES[k]) return;
        diffLine(k, old[k], s[k]);
      });
    }
    if (lines.length === 1) lines.push('更新了记录信息');
    return lines;
  }
  return ['操作了记录'];
}

function auditSummary(log) {
  const lines = auditPlainLines(log);
  return lines[0] || '';
}

async function renderLogs() {
  if (!isSuper()) { toast('仅超级管理员可访问'); location.hash = '#/home'; route(); return; }
  const filterBar = `
    <div class="card" style="margin-bottom:10px">
      <div class="filter-bar" style="margin-bottom:0">
        <input type="month" id="lg-month">
        <select id="lg-op">
          <option value="">全部操作</option>
          <option value="insert">新增</option>
          <option value="update">修改</option>
          <option value="delete">删除</option>
        </select>
        <input type="search" id="lg-q" placeholder="搜用户/手机号/记录ID" style="flex:1;min-width:120px">
      </div>
      <div id="lg-count" class="muted" style="font-size:12px;margin-top:8px"></div>
    </div>
    <div id="lg-list"></div>`;
  pageShell('操作日志', filterBar, { tab: 'logs' });
  const monthStart = (m) => m + '-01T00:00:00';
  const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

  const load = async () => {
    const m = $('#lg-month').value || thisMonth();
    let q = db.from('audit_logs').select('*').gte('created_at', monthStart(m)).lt('created_at', monthStart(nextMonth(m))).order('created_at', { ascending: false }).limit(300);
    const op = $('#lg-op').value;
    if (op) q = q.eq('op', op);
    let rows;
    try { rows = unwrap(await q) || []; }
    catch (e) {
      $('#lg-list').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
      return;
    }
    const kw = $('#lg-q').value.trim();
    if (kw) rows = rows.filter((r) =>
      String(r.user_name || '').includes(kw) || String(r.user_phone || '').includes(kw) || String(r.record_id || '') === kw);
    $('#lg-count').textContent = `共 ${rows.length} 条${rows.length >= 300 ? '（仅显示最近 300 条，请用筛选缩小范围）' : ''} · 日志保留 90 天`;
    $('#lg-list').innerHTML = rows.length ? rows.map((r) => {
      const [bg, fg] = AUDIT_OP_COLORS[r.op] || ['#eee', '#666'];
      const detailStr = JSON.stringify(r.detail, null, 2);
      const plain = auditPlainLines(r).map((t) => `<li>${esc(t)}</li>`).join('');
      return `<div class="card" style="margin-bottom:8px;padding:10px 12px">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="badge" style="background:${bg};color:${fg}">${AUDIT_OP_NAMES[r.op] || r.op}</span>
          <b style="font-size:13px">${esc(AUDIT_TBL_NAMES[r.tbl] || r.tbl)}</b>
          ${r.record_id ? `<span class="muted" style="font-size:12px">#${esc(r.record_id)}</span>` : ''}
          <span style="flex:1"></span>
          <span class="muted" style="font-size:12px">${esc(fmtDT(r.created_at))}</span>
        </div>
        <div style="font-size:13px;margin-top:6px">${esc(r.user_name || '(未登录)')}${r.user_phone ? ` · ${esc(r.user_phone)}` : ''}</div>
        <ul style="font-size:13px;margin:6px 0 0;padding-left:18px;color:var(--ink)">${plain}</ul>
        <details style="margin-top:6px;font-size:12px"><summary style="cursor:pointer;color:var(--ink-faint)">技术明细（调试用）</summary><pre style="white-space:pre-wrap;word-break:break-all;background:var(--line,#f5f5f5);padding:8px;border-radius:6px;margin-top:6px;max-height:240px;overflow:auto">${esc(detailStr)}</pre></details>
      </div>`;
    }).join('') : '<div class="empty">该月份没有日志记录</div>';
  };
  ['lg-op'].forEach((id) => $('#' + id).addEventListener('change', load));
  ['lg-month'].forEach((id) => $('#' + id).addEventListener('change', load));
  let qTimer = null;
  $('#lg-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 300); });
  await load();
}

/* ========== 新建登记 ========== */
let form = {};       // 当前表单数据
let shotFile = null; // 当前截图文件
let shotDataUrl = '';

function renderNew(type, record) {
  const t = TYPES[type];
  if (!t) return renderHome();
  const editing = !!(record && record.id);
  form = { type, recordId: editing ? record.id : null };
  shotFile = null; shotDataUrl = '';
  const p = state.profile;
  const fieldsHtml = buildFields(type, p);
  const shotLabel = type === 'other_income' ? '&#128247; 上传支付凭证' : '&#128247; 截图识别';
  const shotSub = type === 'other_income' ? '收款截图/照片存档' : '截易知鸟页面，AI 自动填';
  const title = editing ? ('编辑' + t.name) : t.name;
  const submitLabel = editing ? '保存修改' : '提交登记';
  pageShell(title, `
    <div class="ai-bar">
      <button type="button" class="ai-btn" id="ai-shot">${shotLabel}<span class="sub">${shotSub}</span></button>
      <button type="button" class="ai-btn" id="ai-voice">&#127908; 语音速记<span class="sub">说一句话，AI 自动填</span></button>
    </div>
    <div id="shot-area"></div>
    <div class="card">${fieldsHtml}</div>
    <div class="field"><label>备注</label><textarea id="f-remark" placeholder="选填"></textarea></div>
    <button class="btn" id="f-submit">${submitLabel}</button>
  `, { back: true, tab: 'home' });
  bindFields(type);
  const afterclass = $('#f-afterclass');
  if (afterclass) {
    const toggleAddr = () => {
      const wrap = $('#f-addr-wrap');
      const isYes = afterclass.value === '是';
      wrap.style.display = isYes ? '' : 'none';
      if (!isYes) { const a = $('#f-addr'); if (a) a.value = ''; }
    };
    afterclass.addEventListener('change', toggleAddr);
    toggleAddr();
  }
  if (editing) {
    fillForm(type, record.payload || {});
    const setX = (id, v) => { const el = $(id); if (el && v !== null && v !== undefined && v !== '') el.value = v; };
    setX('#f-campus', record.campus);
    setX('#f-remark', record.remark);
  }
  $('#ai-shot').addEventListener('click', () => pickShot(type));
  $('#ai-voice').addEventListener('click', () => startVoice(type));
  $('#f-submit').addEventListener('click', () => submitRecord(type, editing ? record : null));
}

function buildFields(type, p) {
  const campusOpts = CAMPUSES.map((c) => `<option ${c === p.campus ? 'selected' : ''}>${c}</option>`).join('');
  if (type === 'course') {
    return `
      <div class="field"><label>上课日期 <span class="req">*</span></label><input id="f-date" type="date" value="${today()}"></div>
      <div class="field"><label>上课时段 <span class="req">*</span></label><div class="row2">
        <input id="f-start" type="time" value="19:00"><input id="f-end" type="time" value="20:30"></div></div>
      <div class="field"><label>课程名称 <span class="req">*</span></label><div class="seg" id="f-course">
        ${COURSES.map((c, i) => `<button type="button" data-v="${c}"${i === 0 ? ' class="on"' : ''}>${c}</button>`).join('')}
        <button type="button" data-v="_other">其他</button></div>
        <input id="f-course-other" placeholder="手动填写课程名称" style="display:none;margin-top:8px"></div>
      <div class="field"><label>实到人数 <span class="req">*</span></label><input id="f-attend" type="number" min="0" inputmode="numeric" placeholder="本堂课实到人数"></div>
      <div class="field"><label>是否课后服务 <span class="req">*</span></label>
        <select id="f-afterclass">
          <option value="">请选择</option>
          <option value="是">是</option>
          <option value="否">否</option>
        </select></div>
      <div class="field" id="f-addr-wrap" style="display:none"><label>课后服务地址 <span class="req">*</span></label>
        <select id="f-addr">
          <option value="">请选择课后服务地址</option>
          ${addrNames().map((a) => `<option>${esc(a)}</option>`).join('')}
        </select></div>
      <div class="field"><label>主教/助教</label><div class="seg" id="f-teachrole">
        <button type="button" data-v="主教" class="on">主教</button><button type="button" data-v="助教">助教</button></div></div>
      <div class="field"><label>校区</label><select id="f-campus">${campusOpts}</select></div>`;
  }
  if (type === 'tuition') {
    const teacherOpts = state.teachers.length
      ? `<select id="f-teacher">${state.teachers.map((t) => `<option value="${esc(t.name)}"${t.name === p.name ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : `<input id="f-teacher" placeholder="授课老师">`;
    return `
      <div class="field"><label>学生姓名 <span class="req">*</span></label><input id="f-student" placeholder="学生姓名"></div>
      <div class="field"><label>学费类型 <span class="req">*</span></label><div class="seg" id="f-feetype">
        <button type="button" data-v="新签">新签</button><button type="button" data-v="续费">续费</button><button type="button" data-v="转介绍">转介绍</button></div>
        <div class="hint">新签＝新签约学生；续费＝老生续费；转介绍＝该学生通过转介绍而来</div></div>
      <div class="field"><label>课程类型 <span class="req">*</span></label><div class="seg" id="f-coursetype">
        ${COURSES.map((c, i) => `<button type="button" data-v="${c}"${i === 0 ? ' class="on"' : ''}>${c}</button>`).join('')}
        <button type="button" data-v="_other">其他</button></div>
        <input id="f-coursetype-other" placeholder="手动填写课程类型" style="display:none;margin-top:8px"></div>
      <div class="field"><label>金额（元） <span class="req">*</span></label><input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="缴费金额"></div>
      <div class="field"><label>收据编号</label><input id="f-receipt" placeholder="选填"></div>
      <div class="field"><label>缴费日期 <span class="req">*</span></label><input id="f-paydate" type="date" value="${today()}"></div>
      <div class="field"><label>授课老师 <span class="req">*</span></label>${teacherOpts}</div>
      <div class="field"><label>成交来源</label><textarea id="f-source" rows="2" placeholder="如：上门咨询 / 老带新转介绍 / 美团体验课…（喜报中展示）"></textarea></div>
      <div class="field"><label>类型（喜报展示）</label><textarea id="f-typenote" rows="2" placeholder="如：新生49+普卡；留空则按学费类型显示"></textarea></div>
      <div class="field"><label>跟进老师（提成归属人）</label><input id="f-commissionto" value="${esc(p.name)}" placeholder="默认为本人"></div>
      <div class="field"><label>校区</label><select id="f-campus">${campusOpts}</select></div>`;
  }
  if (type === 'goods') {
    return `
      <div class="field"><label>物品 <span class="req">*</span></label>
        <div class="row2">
          <input id="f-item-search" placeholder="输入名称/条码搜索">
          <button type="button" class="btn sm ghost" id="f-scan">&#128247; 扫码</button>
        </div>
        <div id="f-item-list"></div>
        <input type="hidden" id="f-barcode"><input type="hidden" id="f-itemname">
        <div class="hint" id="f-item-picked"></div>
        ${isSuper() ? '<button type="button" class="btn sm ghost" id="f-itemsync" style="margin-top:6px">⇅ 同步仓库名录</button>' : ''}</div>
      <div class="field"><label>数量 <span class="req">*</span></label><input id="f-qty" type="number" min="1" value="1" inputmode="numeric"></div>
      <div class="field"><label>金额（元） <span class="req">*</span></label><input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div class="field"><label>学生/客户姓名 <span class="req">*</span></label><input id="f-student" placeholder="学生/客户姓名"></div>
      <div class="field"><label>缴费日期 <span class="req">*</span></label><input id="f-paydate" type="date" value="${today()}"></div>
      <div class="field"><label>授课教师 <span class="req">*</span></label><input id="f-teacher" placeholder="授课教师"></div>
      <div class="field"><label>校区</label><select id="f-campus">${campusOpts}</select></div>`;
  }
  if (type === 'invite') {
    return `
      <div class="field"><label>学生姓名 <span class="req">*</span></label><input id="f-student"></div>
      <div class="field"><label>体验日期 <span class="req">*</span></label><input id="f-trialdate" type="date" value="${today()}"></div>
      <div class="field"><label>意向金额（元）</label><input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="选填"></div>
      <div class="field"><label>体验课老师</label><input id="f-teacher" placeholder="选填"></div>
      <div class="field"><label>校区</label><select id="f-campus">${campusOpts}</select></div>`;
  }
  if (type === 'other_income') {
    return `
      <div class="field"><label>费用名称 <span class="req">*</span></label><input id="f-feename" placeholder="如：中高考培训费、研学报名费"></div>
      <div class="field"><label>收款日期 <span class="req">*</span></label><input id="f-paydate" type="date" value="${today()}"></div>
      <div class="field"><label>金额（元） <span class="req">*</span></label><input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div class="field"><label>学员姓名</label><input id="f-student" placeholder="选填"></div>
      <div class="field"><label>联系电话</label><input id="f-phone" type="tel" maxlength="11" inputmode="numeric" placeholder="选填"></div>
      <div class="field"><label>校区</label><select id="f-campus">${campusOpts}</select></div>
      <div class="tip" style="background:var(--blue-l);border-radius:8px;padding:10px;font-size:12px;color:var(--blue-d)">此类收入不计提成和业绩，财务正常核算。支付凭证：点上方「上传支付凭证」把收款截图/照片传上来（必传，财务要核对）。</div>`;
  }
  if (type === 'summary') {
    return `
      <div class="field"><label>月份 <span class="req">*</span></label><input id="f-month" type="month" value="${thisMonth()}"></div>
      <div class="field"><label>校区</label><select id="f-campus">${campusOpts}</select></div>
      <div class="field"><label>本月校区总业绩（元） <span class="req">*</span></label><input id="f-totalperf" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div class="field"><label>总课销（元）</label><input id="f-totalsales" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div class="field"><label>月上课总课时（节）</label><input id="f-totalhours" type="number" min="0" inputmode="numeric"></div>
      <div class="field"><label>主教课时（节）</label><input id="f-leadhours" type="number" min="0" inputmode="numeric"></div>
      <div class="field"><label>缺勤扣款（元）</label><input id="f-absence" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div class="field"><label>请假扣款（元）</label><input id="f-leave" type="number" min="0" step="0.01" inputmode="decimal"></div>`;
  }
  return '';
}

function bindFields(type) {
  if (type === 'course') {
    segBind('#f-course');
    segBind('#f-teachrole');
    $('#f-course').addEventListener('click', () => {
      $('#f-course-other').style.display = segVal('#f-course') === '_other' ? 'block' : 'none';
    });
  }
  if (type === 'tuition') {
    segBind('#f-feetype');
    segBind('#f-coursetype');
    $('#f-coursetype').addEventListener('click', () => {
      $('#f-coursetype-other').style.display = segVal('#f-coursetype') === '_other' ? 'block' : 'none';
    });
  }
  if (type === 'goods') {
    $('#f-item-search').addEventListener('input', renderItemMatches);
    $('#f-scan').addEventListener('click', openScanner);
    const syncBtn = $('#f-itemsync');
    if (syncBtn) syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      const old = syncBtn.textContent;
      syncBtn.textContent = '同步中…';
      try {
        const r = await apiAdmin('/items/sync-from-wms', { method: 'POST' });
        const s = (r && r.stats) || {};
        await loadBaseData();
        renderItemMatches();
        toast(`名录已同步：新增 ${s.added || 0} · 更新 ${s.updated || 0} · 条码修正 ${s.repointed || 0} · 停用 ${s.deprecated || 0}`);
      } catch (e) {
        toast('同步失败：' + (e.message || '网络异常'));
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = old;
      }
    });
  }
}
function segBind(sel) {
  const box = $(sel);
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    box.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  }));
}
function segVal(sel) { const b = $(sel + ' button.on'); return b ? b.dataset.v : ''; }
function timeToMin(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return NaN;
  const p = t.split(':').map(Number);
  return p[0] * 60 + p[1];
}
/* 同一老师是否存在同日期、时段重叠的已登记课时 */
/* 新增登记截止：次月 2 日 00:00 起不能再新增上月及更早月份记录；本月可随时新增；
   上月仅在当月 1 日（含 23:59 前）可补登。此判定只用于【新增】，不约束已退回记录的修改 */
function isMonthLocked(m) {
  if (!m || !/^\d{4}-\d{2}$/.test(m)) return false;
  const now = new Date();
  const curYM = now.getFullYear() * 12 + now.getMonth();
  const parts = m.split('-');
  const targetYM = Number(parts[0]) * 12 + (Number(parts[1]) - 1);
  if (targetYM === curYM) return false;                 // 本月可登
  if (targetYM === curYM - 1) return now.getDate() >= 2; // 上月：2 号 00:00 起锁
  return true;                                          // 更早或未来月份锁
}

/* 查找时间重叠的已有课时；返回冲突记录 payload，无冲突返回 null */
async function findTimeConflict(date, start, end, excludeId) {
  if (!date || !state.session || !state.session.user) return null;
  const rows = unwrap(await db.from('records').select('*')
    .eq('owner_id', state.session.user.id).eq('type', 'course')) || [];
  const s = timeToMin(start), e = timeToMin(end);
  if (isNaN(s) || isNaN(e)) return null;
  for (const r of rows) {
    if (excludeId && String(r.id) === String(excludeId)) continue;
    const d = r.payload || {};
    if (d.date !== date) continue;
    const ds = timeToMin(d.start_time), de = timeToMin(d.end_time);
    if (isNaN(ds) || isNaN(de)) continue;
    if (s < de && ds < e) return d; // 区间重叠（不含首尾相接）
  }
  return null;
}

/* 拼课规则：有效主教状态（已退回的不占用主教名额） */
const LEAD_ACTIVE_STATUSES = ['pending', 'accounted'];

/* 查同月份全部老师的课时记录中，与给定 日期/时段/校区 重叠的记录（拼课校验用，excludeId 为编辑中的记录自身） */
async function findCourseMates(date, start, end, campus, excludeId) {
  if (!date || !state.session || !state.session.user) return [];
  const s = timeToMin(start), e = timeToMin(end);
  if (isNaN(s) || isNaN(e)) return [];
  let rows = [];
  try {
    rows = unwrap(await db.from('records').select('*').eq('month', date.slice(0, 7)).eq('type', 'course').limit(5000)) || [];
  } catch (e2) { return []; }
  return rows.filter((r) => {
    if (excludeId && String(r.id) === String(excludeId)) return false;
    if ((r.campus || '') !== campus) return false;
    const d = r.payload || {};
    if (d.date !== date) return false;
    const ds = timeToMin(d.start_time), de = timeToMin(d.end_time);
    if (isNaN(ds) || isNaN(de)) return false;
    return s < de && ds < e; // 区间重叠（不含首尾相接）
  });
}

/* 助教登记：弹出同时段同校区的主教课程供关联；resolve({lead}) / resolve({lead:null}) / resolve({cancel:true}) */
function pickAssistLead(leads, currentLeadId) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const items = leads.map((l) => {
      const d = l.payload || {};
      const checked = String(l.id) === String(currentLeadId) ? ' checked' : '';
      return `<label class="assist-opt"><input type="radio" name="assist-lead" value="${l.id}"${checked}>
        <span><b>${esc(l.owner_name || '')}</b> · ${esc(d.course || '')} ${esc(d.start_time || '')}-${esc(d.end_time || '')} · 实到 ${d.attend ?? '-'} 人</span></label>`;
    }).join('');
    mask.innerHTML = `<div class="modal"><h3>选择本节课的主教</h3>
      <div class="hint" style="margin-bottom:10px">拼课助教需关联主教课程，财务按主教/助教分别核算课时费。</div>
      ${items || '<div class="empty">该时段同校区暂无其他老师登记的主教课程</div>'}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn" id="assist-ok" style="flex:1">${leads.length ? '确认关联并提交' : '仍要提交（待关联主教）'}</button>
        <button class="btn ghost" id="assist-cancel">取消</button>
      </div></div>`;
    document.body.appendChild(mask);
    const done = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('#assist-cancel').addEventListener('click', () => done({ cancel: true }));
    mask.querySelector('#assist-ok').addEventListener('click', () => {
      if (!leads.length) return done({ lead: null });
      const sel = mask.querySelector('input[name="assist-lead"]:checked');
      if (!sel) { toast('请选择主教课程，或点「取消」'); return; }
      const lead = leads.find((l) => String(l.id) === sel.value);
      done({ lead: lead || null });
    });
  });
}

/* 物品搜索 */
function renderItemMatches() {
  const q = $('#f-item-search').value.trim().toLowerCase();
  const box = $('#f-item-list');
  if (!q) { box.innerHTML = ''; return; }
  const hits = activeItems().filter((it) =>
    (it.name || '').toLowerCase().includes(q) || (it.barcode || '').includes(q)).slice(0, 8);
  box.innerHTML = hits.length
    ? hits.map((it) => `<div class="rec" style="cursor:pointer" data-barcode="${esc(it.barcode)}" data-name="${esc(it.name)}">
        <div class="rmain">${esc(it.name)} <span class="hint">${esc(it.barcode)} · ${esc(it.category || '')}</span></div></div>`).join('')
    : '<div class="empty">没有匹配的物品（联系财务在名录中添加）</div>';
  box.querySelectorAll('.rec').forEach((el) => el.addEventListener('click', () => {
    $('#f-barcode').value = el.dataset.barcode;
    $('#f-itemname').value = el.dataset.name;
    $('#f-item-picked').textContent = '已选：' + el.dataset.name + '（' + el.dataset.barcode + '）';
    $('#f-item-search').value = el.dataset.name;
    box.innerHTML = '';
  }));
}

/* 扫码 */
let html5Qr = null;
async function openScanner() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal"><h3>扫描物品条码</h3><div id="scan-box"></div>
    <button class="btn ghost" id="scan-close">关闭</button></div>`;
  document.body.appendChild(mask);
  const close = async () => { try { if (html5Qr) await html5Qr.stop(); } catch (e) {} mask.remove(); };
  mask.querySelector('#scan-close').addEventListener('click', close);
  try {
    if (!window.Html5Qrcode) {
      await import('https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js').catch(() => {});
      if (!window.Html5Qrcode) await loadScript('https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js');
    }
    html5Qr = new Html5Qrcode('scan-box');
    await html5Qr.start({ facingMode: 'environment' }, { fps: 8 }, (text) => {
      const it = activeItems().find((x) => x.barcode === text.trim());
      if (it) {
        $('#f-barcode').value = it.barcode; $('#f-itemname').value = it.name;
        $('#f-item-picked').textContent = '已选：' + it.name + '（' + it.barcode + '）';
        $('#f-item-search').value = it.name;
        toast('识别成功：' + it.name);
      } else { toast('条码 ' + text + ' 不在名录中，请搜索选择'); }
      close();
    }, () => {});
  } catch (e) { toast('无法打开摄像头，请用搜索选择物品'); close(); }
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

/* ========== 截图识别 ========== */
function pickShot(type) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => { if (input.files[0]) handleShot(input.files[0], type); };
  input.click();
}
function handleShot(file, type) {
  shotFile = file;
  const reader = new FileReader();
  reader.onload = async (e) => {
    shotDataUrl = await compressImage(e.target.result);
    const isVoucher = type === 'other_income';
    $('#shot-area').innerHTML = `<div class="card"><h3>${isVoucher ? '支付凭证（提交时随记录保存）' : '已选截图'}</h3><img class="shot-preview" src="${shotDataUrl}">
      <button class="btn sm" id="ai-parse" style="margin-top:10px">${isVoucher ? '识别填充（可选）' : '开始智能识别'}</button></div>`;
    $('#ai-parse').addEventListener('click', () => runImageParse(type));
  };
  reader.readAsDataURL(file);
}
function compressImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const max = 1280; let { width: w, height: h } = img;
      if (w > max) { h = Math.round(h * max / w); w = max; }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const AI_FIELDS_DESC = {
  course: '课程名称 course（如：硬笔、毛笔、美术）、实到人数 attend（数字）、上课日期 date（YYYY-MM-DD）、开始时间 start_time（HH:MM）、结束时间 end_time（HH:MM）、校区 campus',
  tuition: '学生姓名 student、金额 amount（数字）、收据编号 receipt_no、缴费日期 pay_date（YYYY-MM-DD）、学费类型 fee_type（只能是：新签 / 续费 / 转介绍，根据语气判断，如提到老生续缴选续费，提到朋友/家长推荐选转介绍，新学生首次缴费选新签）、课程类型 course_type（如：硬笔书法/毛笔书法/美术）、授课老师 teacher（姓名）、成交来源 source（如：上门咨询/老带新）、类型 typenote（喜报展示用，如：新生49+普卡，没有则 null）',
  goods: '物品名称 item_name、数量 qty（数字）、金额 amount（数字）、学生姓名 student、缴费日期 pay_date（YYYY-MM-DD）',
  invite: '学生姓名 student、体验日期 trial_date（YYYY-MM-DD）、意向金额 amount（数字）、体验课老师 teacher',
  other_income: '费用名称 fee_name（如：中高考培训费、研学报名费）、金额 amount（数字）、收款日期 pay_date（YYYY-MM-DD）、学员姓名 student、联系电话 phone',
  summary: '月份 month（YYYY-MM）、总业绩 total_perf、总课销 total_sales、月上课总课时 total_hours、主教课时 lead_hours、缺勤扣款 absence、请假扣款 leave（均为数字）',
};
const AI_SYSTEM = '你是教务数据录入助手，负责从「易知鸟」培训机构管理系统的截图或用户的口述文字中提取结构化字段。规则：1) 只输出 JSON 对象，不要输出任何其他文字；2) 识别不出的字段填 null，不要编造；3) 人数、金额、数量必须是数字；4) 日期统一 YYYY-MM-DD，时间统一 24 小时制 HH:MM；5) 今天是' + today() + '，未标明年份的日期按当前年份补全。';

async function llmJson(userContent, isImage) {
  const model = isImage ? state.imageModel : state.textModel;
  if (!model) throw new Error(isImage ? '当前无可用识图模型' : '当前无可用模型');
  const userMsg = isImage
    ? { role: 'user', content: [{ type: 'text', text: userContent }, { type: 'image_url', image_url: { url: shotDataUrl } }] }
    : { role: 'user', content: userContent };
  let out = '';
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [{ role: 'system', content: AI_SYSTEM }, userMsg],
    stream: true,
    response_format: { type: 'json_object' },
  })) {
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
    if (d) out += d;
  }
  const cleaned = out.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function runImageParse(type) {
  if (!shotDataUrl) { toast('请先选择截图'); return; }
  if (!state.imageModel) { toast('识图模型暂不可用，请手动填写'); return; }
  const btn = $('#ai-parse'); btn.disabled = true; btn.textContent = 'AI 识别中…';
  try {
    const data = await llmJson(`请从这张截图中提取以下字段：${AI_FIELDS_DESC[type]}`, true);
    fillForm(type, data);
    form.ai_raw = JSON.stringify(data);
    toast('识别完成，请核对后提交');
  } catch (e) { toast('识别失败：' + (e.message || '请重试')); }
  btn.disabled = false; btn.textContent = '重新识别';
}

/* 语音速记：手动停止 + 实时转写 + 可编辑后再解析 */
let voiceRec = null;
function startVoice(type) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal"><h3>语音速记</h3>
    <p class="hint" style="margin-bottom:10px">${SR ? '点「开始说话」，说完后点「停止」，确认文字无误再点「AI 解析填入」。也可以直接打字。' : '当前浏览器不支持语音识别，请直接输入一句话（或用输入法的语音输入）。'}</p>
    <div class="field"><textarea id="voice-text" placeholder="例如：今晚金城校区硬笔班实到12人，7点半到9点" style="min-height:90px"></textarea></div>
    ${SR ? '<button class="btn teal" id="voice-toggle">&#127908; 开始说话</button>' : ''}
    <button class="btn" id="voice-parse">AI 解析填入</button>
    <button class="btn ghost" id="voice-cancel">取消</button></div>`;
  document.body.appendChild(mask);
  const close = () => { try { if (voiceRec) voiceRec.stop(); } catch (e) {} voiceRec = null; mask.remove(); };
  mask.querySelector('#voice-cancel').addEventListener('click', close);
  mask.querySelector('#voice-parse').addEventListener('click', () => {
    const text = mask.querySelector('#voice-text').value.trim();
    if (!text) { toast('请先说话或输入内容'); return; }
    close();
    runTextParse(type, text);
  });
  if (SR) {
    const btn = mask.querySelector('#voice-toggle');
    const area = mask.querySelector('#voice-text');
    let recording = false;
    btn.addEventListener('click', () => {
      if (recording) { try { voiceRec.stop(); } catch (e) {} return; }
      voiceRec = new SR();
      voiceRec.lang = 'zh-CN';
      voiceRec.continuous = true;      /* 不自动停止 */
      voiceRec.interimResults = true;  /* 实时显示 */
      let committed = area.value ? area.value + ' ' : '';
      voiceRec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) committed += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        area.value = committed + interim;
      };
      voiceRec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('麦克风权限被拒绝，请直接打字输入');
        else if (e.error !== 'aborted') toast('识别中断（' + e.error + '），文字已保留，可继续或解析');
      };
      voiceRec.onend = () => {
        recording = false;
        btn.innerHTML = '&#127908; 开始说话';
        btn.classList.remove('red'); btn.classList.add('teal');
      };
      try {
        voiceRec.start();
        recording = true;
        btn.innerHTML = '&#9632; 停止（说完点这里）';
        btn.classList.remove('teal'); btn.classList.add('red');
      } catch (e) { toast('启动失败，请直接打字输入'); }
    });
  }
}
async function runTextParse(type, text) {
  toast('AI 解析中…');
  try {
    const data = await llmJson(`请从这句话中提取字段：${AI_FIELDS_DESC[type]}。原话：${text}`, false);
    fillForm(type, data);
    form.ai_raw = JSON.stringify({ voice: text, parsed: data });
    toast('解析完成，请核对后提交');
  } catch (e) { toast('解析失败：' + (e.message || '请重试')); }
}

/* AI 结果回填 */
function fillForm(type, d) {
  const set = (id, v) => { const el = $(id); if (el && v !== null && v !== undefined && v !== '') el.value = v; };
  if (type === 'course') {
    if (d.course) {
      const btn = Array.from($('#f-course').querySelectorAll('button')).find((b) => b.dataset.v === d.course || (b.dataset.v !== '_other' && d.course && d.course.includes(b.dataset.v)));
      if (btn) btn.click();
      else { $('#f-course').querySelector('[data-v="_other"]').click(); set('#f-course-other', d.course); }
    }
    set('#f-date', d.date); set('#f-start', d.start_time); set('#f-end', d.end_time); set('#f-attend', d.attend);
    set('#f-afterclass', d.afterclass);
    if (d.afterclass === '是') { const ac = $('#f-afterclass'); if (ac) ac.dispatchEvent(new Event('change')); setAddrSelect(d.service_addr); }
    if (d.teach_role && $('#f-teachrole')) {
      const rb = Array.from($('#f-teachrole').querySelectorAll('button')).find((b) => b.dataset.v === d.teach_role);
      if (rb) rb.click();
    }
  } else if (type === 'tuition') {
    set('#f-student', d.student); set('#f-amount', d.amount); set('#f-receipt', d.receipt_no); set('#f-paydate', d.pay_date); set('#f-teacher', d.teacher); set('#f-source', d.source); set('#f-typenote', d.typenote); set('#f-commissionto', d.commission_to);
    if (d.fee_type && ['新签', '续费', '转介绍'].includes(d.fee_type)) {
      const btn = Array.from($('#f-feetype').querySelectorAll('button')).find((b) => b.dataset.v === d.fee_type);
      if (btn) btn.click();
    }
    if (d.course_type) {
      const btn = Array.from($('#f-coursetype').querySelectorAll('button')).find((b) => b.dataset.v === d.course_type);
      if (btn) btn.click();
      else { const ob = $('#f-coursetype').querySelector('[data-v="_other"]'); if (ob) ob.click(); set('#f-coursetype-other', d.course_type); }
    }
  } else if (type === 'goods') {
    set('#f-qty', d.qty); set('#f-amount', d.amount); set('#f-student', d.student); set('#f-paydate', d.pay_date); set('#f-teacher', d.teacher);
    if (d.item_name) {
      $('#f-item-search').value = d.item_name;
      if (d.barcode) $('#f-barcode').value = d.barcode;
      $('#f-itemname').value = d.item_name;
      const it = activeItems().find((x) => x.name === d.item_name || x.name.includes(d.item_name));
      if (it) {
        $('#f-barcode').value = it.barcode; $('#f-itemname').value = it.name;
        $('#f-item-picked').textContent = '已选：' + it.name + '（' + it.barcode + '）';
      } else {
        $('#f-item-picked').textContent = '已选：' + d.item_name + (d.barcode ? '（' + d.barcode + '）' : '');
      }
    }
  } else if (type === 'invite') {
    set('#f-student', d.student); set('#f-trialdate', d.trial_date); set('#f-amount', d.amount); set('#f-teacher', d.teacher);
  } else if (type === 'other_income') {
    set('#f-feename', d.fee_name); set('#f-paydate', d.pay_date); set('#f-amount', d.amount); set('#f-student', d.student); set('#f-phone', d.phone);
  } else if (type === 'summary') {
    set('#f-month', d.month); set('#f-totalperf', d.total_perf); set('#f-totalsales', d.total_sales);
    set('#f-totalhours', d.total_hours); set('#f-leadhours', d.lead_hours); set('#f-absence', d.absence); set('#f-leave', d.leave);
  }
}

/* ========== 提交登记 ========== */
async function submitRecord(type, editRec) {
  const editId = editRec ? editRec.id : null;
  const p = state.profile;
  const num = (id) => { const v = $(id) ? $(id).value : ''; return v === '' ? null : Number(v); };
  const str = (id) => ($(id) ? $(id).value.trim() : '');
  let payload = {}, month = null, err = '';
  if (type === 'course') {
    let course = segVal('#f-course');
    if (course === '_other') course = str('#f-course-other');
    const afterclass = str('#f-afterclass');
    const addr = afterclass === '是' ? str('#f-addr') : '';
    payload = { course, date: str('#f-date'), start_time: str('#f-start'), end_time: str('#f-end'), attend: num('#f-attend'), teach_role: segVal('#f-teachrole'), afterclass, service_addr: addr };
    month = payload.date ? payload.date.slice(0, 7) : null;
    if (!course) err = '请选择或填写课程名称';
    else if (!payload.date) err = '请选择上课日期';
    else if (payload.attend === null) err = '请填写实到人数';
    else if (afterclass !== '是' && afterclass !== '否') err = '请选择是否课后服务';
    else if (afterclass === '是' && !addr) err = '请选择课后服务地址';
  } else if (type === 'tuition') {
    let courseType = segVal('#f-coursetype');
    if (courseType === '_other') courseType = str('#f-coursetype-other');
    payload = { student: str('#f-student'), fee_type: segVal('#f-feetype'), course_type: courseType, amount: num('#f-amount'), receipt_no: str('#f-receipt'), pay_date: str('#f-paydate'), teacher: str('#f-teacher'), source: str('#f-source'), typenote: str('#f-typenote'), commission_to: str('#f-commissionto') };
    month = payload.pay_date ? payload.pay_date.slice(0, 7) : null;
    if (!payload.student) err = '请填写学生姓名';
    else if (!payload.fee_type) err = '请选择学费类型（新签 / 续费 / 转介绍）';
    else if (!payload.course_type) err = '请选择或填写课程类型';
    else if (payload.amount === null) err = '请填写金额';
    else if (!payload.pay_date) err = '请选择缴费日期';
    else if (!payload.teacher) err = '请选择授课老师';
  } else if (type === 'goods') {
    payload = { barcode: str('#f-barcode'), item_name: str('#f-itemname') || str('#f-item-search'), qty: num('#f-qty'), amount: num('#f-amount'), student: str('#f-student'), pay_date: str('#f-paydate'), teacher: str('#f-teacher') };
    month = payload.pay_date ? payload.pay_date.slice(0, 7) : null;
    if (!payload.item_name) err = '请选择物品';
    else if (payload.qty === null) err = '请填写数量';
    else if (payload.amount === null) err = '请填写金额';
    else if (!payload.pay_date) err = '请选择缴费日期';
    else if (!payload.student) err = '请填写学生/客户姓名';
    else if (!payload.teacher) err = '请填写授课教师';
  } else if (type === 'invite') {
    payload = { student: str('#f-student'), trial_date: str('#f-trialdate'), amount: num('#f-amount'), teacher: str('#f-teacher') };
    month = payload.trial_date ? payload.trial_date.slice(0, 7) : null;
    if (!payload.student) err = '请填写学生姓名';
    else if (!payload.trial_date) err = '请选择体验日期';
  } else if (type === 'other_income') {
    payload = { fee_name: str('#f-feename'), pay_date: str('#f-paydate'), amount: num('#f-amount'), student: str('#f-student'), phone: str('#f-phone') };
    month = payload.pay_date ? payload.pay_date.slice(0, 7) : null;
    if (!payload.fee_name) err = '请填写费用名称';
    else if (!payload.pay_date) err = '请选择收款日期';
    else if (payload.amount === null) err = '请填写金额';
    else if (!shotFile && !(editRec && editRec.images && editRec.images.length)) err = '请上传支付凭证（收款截图/照片）';
  } else if (type === 'summary') {
    payload = { month: str('#f-month'), total_perf: num('#f-totalperf'), total_sales: num('#f-totalsales'), total_hours: num('#f-totalhours'), lead_hours: num('#f-leadhours'), absence: num('#f-absence'), leave: num('#f-leave') };
    month = payload.month;
    if (!payload.month) err = '请选择月份';
    else if (payload.total_perf === null) err = '请填写本月校区总业绩';
  }
  if (err) { toast(err); return; }
  /* 新增登记截止：次月 2 日 00:00 起不能再新增该月及更早月份的记录（仅业务登记类型，财务核算参数除外）。
     注意：此限制只约束【新增】；已退回记录的修改不受截止限制（财务退回往往发生在截止后，老师仍需能改） */
  if (!editId && type !== 'summary' && isMonthLocked(month)) {
    toast('该月份已超过新增登记截止时间（次月 2 日 00:00 起不能新增记录）');
    return;
  }
  /* 课时登记：同一老师不可重复填报时间重叠的课时 */
  if (type === 'course') {
    let conflict = null;
    try { conflict = await findTimeConflict(payload.date, payload.start_time, payload.end_time, editId); }
    catch (e) { conflict = null; }
    if (conflict) {
      const ctimes = (conflict.start_time && conflict.end_time) ? ` ${conflict.start_time}-${conflict.end_time}` : '';
      const cname = conflict.course ? `（${conflict.course}）` : '';
      toast(`与已有课时${ctimes}${cname}时间重叠，请核对上课时间再填写`);
      return;
    }
  }
  /* 拼课规则：同一时段同一校区只能有一名有效主教（已退回不算）；助教需关联主教课程，无主教的课可先提交、由财务审核时核对 */
  if (type === 'course') {
    const campusVal = str('#f-campus') || p.campus;
    const mates = await findCourseMates(payload.date, payload.start_time, payload.end_time, campusVal, editId);
    const activeLeads = mates.filter((m) => (m.payload || {}).teach_role === '主教' && LEAD_ACTIVE_STATUSES.includes(m.status));
    if (payload.teach_role === '主教') {
      delete payload.assist_for; delete payload.assist_for_name;
      if (activeLeads.length) {
        const l = activeLeads[0]; const ld = l.payload || {};
        toast(`该时段 ${campusVal} 已有主教「${l.owner_name || ''}」（${ld.course || ''} ${ld.start_time || ''}-${ld.end_time || ''}），拼课请改选「助教」`);
        return;
      }
    } else if (payload.teach_role === '助教') {
      const choice = await pickAssistLead(activeLeads, editRec && editRec.payload && editRec.payload.assist_for);
      if (choice.cancel) return;
      if (choice.lead) {
        payload.assist_for = choice.lead.id;
        payload.assist_for_name = choice.lead.owner_name;
      } else {
        delete payload.assist_for; delete payload.assist_for_name;
      }
    }
  }
  const btn = $('#f-submit'); btn.disabled = true; btn.textContent = '提交中…';
  try {
    let images = null;
    if (shotFile) {
      const path = cloud.storage.userPath(state.session.user.id, `shots/${Date.now()}.jpg`);
      const up = await cloud.storage.upload(path, shotFile, { contentType: shotFile.type || 'image/jpeg' });
      if (!up.error) images = [path];
    }
    if (editId) {
      /* 编辑权限规则（2026-10-31 用户确认）：仅「已退回」记录可修改；
         保存后自动回到待审核并清除退回原因。待审核/已核算一律不可改。 */
      if (editRec && editRec.status !== 'returned') {
        toast(editRec.status === 'accounted' ? '该记录已核算，不能修改'
          : '该记录已提交审核，不能修改；如需变更请联系财务退回后再改');
        btn.disabled = false; btn.textContent = '保存';
        return;
      }
      const upd = { payload, month, campus: str('#f-campus') || p.campus, remark: str('#f-remark') || null, updated_at: new Date().toISOString() };
      // 已退回记录修改后重新进入待审核队列，并清除退回原因备注
      upd.status = 'pending';
      if (upd.remark && upd.remark.indexOf('退回原因：') === 0) upd.remark = null;
      if (images) upd.images = images;
      // 数据库层兜底：仅 returned 状态可被本次更新命中，提交后/已核算记录在数据库层拒绝
      const res = await db.from('records').update(upd).eq('id', editId).eq('status', 'returned').select();
      if (res.error) toast('保存失败：' + res.error.message);
      else if (!(res.data || []).length) toast('该记录已提交或已核算，不能修改（仅已退回可修改）');
      else toast('已重新提交审核');
    } else {
      await db.from('records').insert({
        owner_name: p.name,
        type, campus: str('#f-campus') || p.campus, month,
        payload, images,
        remark: str('#f-remark') || null,
        ai_raw: form.ai_raw || null,
      });
      toast('已提交，等待财务审核');
    }
    location.hash = '#/mine';
  } catch (e) {
    toast('提交失败：' + (e.message || '网络异常'));
    btn.disabled = false; btn.textContent = '提交登记';
  }
}

/* ========== 记录卡片 ========== */
function recMain(r) {
  const d = r.payload || {};
  if (r.type === 'course') {
    let roleTxt = esc(d.teach_role || '');
    if (d.teach_role === '助教') {
      roleTxt = d.assist_for_name
        ? `助教（辅助 <b>${esc(d.assist_for_name)}</b> 主教）`
        : '<span class="badge warn">助教 · 待关联主教</span>';
    }
    return `${esc(d.course || '')} ${esc(d.date || '')} ${esc(d.start_time || '')}-${esc(d.end_time || '')}<br>实到 <b>${d.attend ?? '-'}</b> 人 · ${roleTxt} · 课后服务：${esc(d.afterclass || '未填')}${d.service_addr ? ' · ' + esc(d.service_addr) : ''}`;
  }
  if (r.type === 'tuition') return `学生：${esc(d.student || '')} · <b>¥${d.amount ?? '-'}</b>${d.fee_type ? ' · ' + esc(d.fee_type) : ''}${d.course_type ? ' · ' + esc(d.course_type) : ''}<br>缴费 ${esc(d.pay_date || '')} · 收据 ${esc(d.receipt_no || '无')}<br>授课 ${esc(d.teacher || '未填')} · 跟进老师（提成归属） ${esc(d.commission_to || '')}${d.source ? '<br>成交来源：' + esc(d.source) : ''}${d.typenote ? '<br>类型（喜报）：' + esc(d.typenote) : ''}`;
  if (r.type === 'goods') return `物品：${esc(d.item_name || '')} × ${d.qty ?? '-'} · <b>¥${d.amount ?? '-'}</b><br>缴费 ${esc(d.pay_date || '')}${d.student ? ' · ' + esc(d.student) : ''}`;
  if (r.type === 'invite') return `学生：${esc(d.student || '')} · 体验 ${esc(d.trial_date || '')}${d.amount ? ' · 意向 ¥' + d.amount : ''}${d.teacher ? ' · ' + esc(d.teacher) : ''}`;
  if (r.type === 'other_income') return `费用：${esc(d.fee_name || '')} · <b>¥${d.amount ?? '-'}</b><br>收款 ${esc(d.pay_date || '')}${d.student ? ' · ' + esc(d.student) : ''}${d.phone ? ' · ' + esc(d.phone) : ''}`;
  if (r.type === 'summary') return `${esc(d.month || '')} 总业绩 <b>¥${d.total_perf ?? '-'}</b> · 课销 ¥${d.total_sales ?? '-'}<br>总课时 ${d.total_hours ?? '-'} 节 · 主教课时 ${d.lead_hours ?? '-'}`;
  return '';
}
function recCard(r, actions) {
  const s = STATUS[r.status] || { name: r.status, cls: 'pending' };
  const voucherBtn = (r.images && r.images.length)
    ? `<button class="btn sm ghost" onclick="viewImage('${esc(r.images[0])}')">&#128247; 凭证</button>` : '';
  const allActions = (actions || '') + voucherBtn;
  return `<div class="rec">
    <div class="rhead"><span class="rtype">${TYPES[r.type] ? TYPES[r.type].name : r.type}</span><span class="badge ${s.cls}">${s.name}</span></div>
    <div class="rmain">${recMain(r)}</div>
    <div class="rmeta">${esc(r.owner_name || '')} · ${esc(r.campus || '')} · ${fmtDT(r.created_at)}${r.remark ? ' · 备注：' + esc(r.remark) : ''}</div>
    ${allActions ? `<div class="ractions">${allActions}</div>` : ''}
  </div>`;
}
async function viewImage(path) {
  try {
    const res = await cloud.storage.createSignedUrl(path, 600);
    const url = res && res.data ? (res.data.url || res.data) : null;
    if (url) window.open(url, '_blank');
    else toast('凭证加载失败');
  } catch (e) { toast('凭证加载失败：' + (e.message || '')); }
}

/* ========== 我的记录 ========== */
async function renderMine(hash) {
  pageShell('我的记录', '<div class="loading-box">加载中…</div>', { tab: 'mine' });
  /* 支持深链 #/mine?status=returned&all=1（退回提醒弹窗直达）：all=1 时不过滤月份 */
  const qs = (hash && hash.includes('?')) ? new URLSearchParams(hash.split('?')[1]) : null;
  const initStatus = (qs && qs.get('status')) || '';
  const initType = (qs && qs.get('type')) || '';
  const allMonths = !!(qs && qs.get('all') === '1');
  let rows = [];
  const filterBar = `
    <div class="card" style="margin-bottom:10px">
      <div class="filter-bar" style="margin-bottom:0">
        <input type="month" id="mn-month" value="${allMonths ? '' : thisMonth()}">
        <select id="mn-type">
          <option value="">全部类型</option>
          ${Object.entries(TYPES).filter(([k]) => k !== 'summary').map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('')}
        </select>
        <select id="mn-status">
          <option value="">全部状态</option>
          <option value="pending">已提交</option>
          <option value="accounted">已核算</option>
          <option value="returned">已退回</option>
        </select>
        <input type="search" id="mn-search" placeholder="搜索学生姓名" style="flex:1;min-width:120px">
      </div>
      <div id="mn-count" class="muted" style="font-size:12px;margin-top:8px"></div>
    </div>
    <div id="mn-list"></div>`;
  const loadRows = async () => {
    try {
      let q = db.from('records').select('*').eq('owner_id', state.session.user.id);
      const m = $('#mn-month').value;
      if (m) q = q.eq('month', m);
      rows = unwrap(await q.order('created_at', { ascending: false }).limit(1000)) || [];
    } catch (e) { toast('加载失败：' + e.message); rows = []; }
  };
  const bindActions = () => {
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(canErase() ? '确定彻底删除该记录？\n删除后不可恢复，也不会留下任何记录。' : '确定删除这条记录？')) return;
      const res = await db.from('records').delete().eq('id', b.dataset.del).select();
      if (res.error || !(res.data || []).length) toast('删除失败');
      else { toast('已删除'); applyFilters(); }
    }));
    document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const row = rows.find((r) => String(r.id) === b.dataset.edit);
      if (row) renderNew(row.type, row);
      else toast('找不到该记录，请刷新后重试');
    }));
  };
  const applyFilters = () => {
    const t = $('#mn-type').value;
    const st = $('#mn-status').value;
    const q = $('#mn-search').value.trim();
    const list = rows.filter((r) =>
      (!t || r.type === t) &&
      (!st || r.status === st) &&
      (!q || String((r.payload || {}).student || '').includes(q)));
    $('#mn-count').textContent = `共 ${list.length} 条记录`;
    $('#mn-list').innerHTML = list.length ? list.map((r) => {
      let actions = '';
      if (['pending', 'returned'].includes(r.status) || canErase()) {
        actions += `<button class="btn sm ghost" data-del="${r.id}">删除</button>`;
      }
      if (r.type !== 'summary') {
        /* 编辑权限只看审核状态，不受月份截止限制：仅「已退回」可修改（保存后回待审核）；
           待审核=提交即锁定；已核算=财务定稿不可改 */
        if (r.status === 'returned') actions += `<button class="btn sm ghost" data-edit="${r.id}">补充/编辑</button>`;
        else if (r.status === 'pending') actions += `<span class="badge" style="background:#fff4e5;color:#e65100">已提交·不可改</span>`;
        else actions += `<span class="badge" style="background:#e8f5e9;color:#2e7d32">已核算·不可改</span>`;
      }
      return recCard(r, actions);
    }).join('') : '<div class="empty">没有匹配的记录</div>';
    bindActions();
  };
  pageShell('我的记录', filterBar, { tab: 'mine' });
  if (initStatus) $('#mn-status').value = initStatus;
  if (initType && $('#mn-type').querySelector(`option[value="${initType}"]`)) $('#mn-type').value = initType;
  ['mn-month'].forEach((id) => $('#' + id).addEventListener('change', async () => { await loadRows(); applyFilters(); }));
  ['mn-type', 'mn-status'].forEach((id) => $('#' + id).addEventListener('change', applyFilters));
  $('#mn-search').addEventListener('input', applyFilters);
  await loadRows();
  applyFilters();
}

/* ========== 退回记录提醒：每次打开系统时检测，有被退回记录即弹窗 ========== */
async function checkReturnedAndAlert() {
  if (!state.session || !state.session.user) return;
  try {
    const rows = unwrap(await db.from('records').select('id').eq('owner_id', state.session.user.id).eq('status', 'returned').limit(100)) || [];
    if (!rows.length) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:420px;text-align:left">
        <h3 style="display:flex;align-items:center;gap:8px"><span class="badge returned">退回提醒</span></h3>
        <p style="font-size:15px;margin:4px 0 6px">你有 <b style="color:var(--zx-seal);font-size:20px">${rows.length}</b> 条记录被退回</p>
        <p class="muted">请修改后重新提交，财务会重新审核。</p>
        <div style="display:flex;gap:10px;margin-top:18px">
          <button class="btn ghost" id="rt-later" style="flex:1;margin-top:0">知道了</button>
          <button class="btn" id="rt-go" style="flex:1;margin-top:0">去修改</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    $('#rt-later').addEventListener('click', () => mask.remove());
    $('#rt-go').addEventListener('click', () => { mask.remove(); location.hash = '#/mine?status=returned&all=1'; });
  } catch (e) { /* 查询失败不打扰正常使用 */ }
}

/* ========== 审核（财务/管理直接审核） ========== */
/* 记录的业务时间：课时=上课日期+开始时间，学费/物品/其他收入=缴费日期，邀约=体验日期；均无则退回提交时间 */
function recBizTime(r) {
  const d = r.payload || {};
  if (r.type === 'course') return (d.date || '') + ' ' + (d.start_time || '00:00');
  if (r.type === 'tuition' || r.type === 'goods' || r.type === 'other_income') return d.pay_date || '';
  if (r.type === 'invite') return d.trial_date || '';
  return (r.created_at || '').slice(0, 16).replace('T', ' ');
}
const APPROVE_FLOW = {
  finance: { from: 'pending', pass: 'accounted', passLabel: '审核通过' },
  leader:  { from: 'pending', pass: 'accounted', passLabel: '审核通过' },
};
async function renderApprove() {
  const flow = canFinance() ? APPROVE_FLOW.finance : null;
  if (!flow) { pageShell('审核', '<div class="empty">当前角色无审核权限</div>', { tab: 'approve' }); return; }
  pageShell('审核', '<div class="loading-box">加载中…</div>', { tab: 'approve' });
  let rows = [];
  const filterBar = `
    <div class="card" style="margin-bottom:10px">
      <div class="filter-bar" style="margin-bottom:0">
        <input type="month" id="ap-month" value="${thisMonth()}">
        <select id="ap-status">
          <option value="pending">待审核</option>
          <option value="accounted">已核算</option>
          <option value="returned">已退回</option>
          <option value="">全部状态</option>
        </select>
        <select id="ap-type">
          <option value="">全部类型</option>
          ${Object.entries(TYPES).filter(([k]) => k !== 'summary').map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('')}
        </select>
        <select id="ap-after" style="display:none">
          <option value="">课后服务：全部</option>
          <option value="是">课后服务：是</option>
          <option value="否">课后服务：否</option>
        </select>
        <select id="ap-teacher">
          <option value="">全部教师</option>
        </select>
        <select id="ap-sort">
          <option value="desc">上课时间：最新优先</option>
          <option value="asc">上课时间：最早优先</option>
        </select>
        <input type="date" id="ap-date" title="按上课/缴费日期筛选">
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <button class="btn sm teal" id="ap-batch">批量审核通过</button>
        <label style="font-size:12px;color:var(--ink-faint)"><input type="checkbox" id="ap-all" style="vertical-align:-2px"> 全选</label>
        <span id="ap-count" class="muted" style="font-size:12px"></span>
      </div>
      <p class="muted" style="font-size:11px;margin:6px 0 0">教师名单随状态联动：选「待审核/已核算/已退回」时只列出有该状态记录的老师；「全部状态」列出全部提交人；「待审核」视图才显示勾选与审核按钮。超级管理员对任意状态记录可「彻底删除」，对「已核算/已退回」记录可「回退待审核」。</p>
    </div>
    <div id="ap-list"></div>`;
  pageShell('审核', filterBar, { tab: 'approve' });

  const bindActions = () => {
    document.querySelectorAll('[data-pass]').forEach((b) => b.addEventListener('click', () => setStatus(b.dataset.pass, flow.pass, flow.passLabel)));
    document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', async () => {
      const reason = prompt('退回原因（会显示给填报人）：');
      if (reason === null) return;
      const res = await db.from('records').update({ status: 'returned', remark: (reason ? '退回原因：' + reason : null), updated_at: new Date().toISOString() }).eq('id', b.dataset.back).select();
      if (res.error || !(res.data || []).length) toast('操作失败');
      else { toast('已退回'); load(); }
    }));
    document.querySelectorAll('[data-erase]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('确定彻底删除该记录？\n删除后不可恢复，也不会留下任何记录。')) return;
      const res = await db.from('records').delete().eq('id', b.dataset.erase).select();
      if (res.error || !(res.data || []).length) toast('删除失败：' + ((res.error && res.error.message) || '无权限'));
      else { toast('已彻底删除'); load(); }
    }));
    /* 超管专属：已核算/已退回记录误操作时回退到待审核 */
    document.querySelectorAll('[data-revert]').forEach((b) => b.addEventListener('click', async () => {
      const fromLabel = b.dataset.from === 'returned' ? '已退回' : '已核算';
      if (!confirm(`确定把这条「${fromLabel}」记录回退到「待审核」？\n回退后需财务重新审核。`)) return;
      const res = await db.from('records').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('id', b.dataset.revert).select();
      if (res.error || !(res.data || []).length) toast('回退失败：' + ((res.error && res.error.message) || '无权限'));
      else { toast('已回退到待审核'); load(); }
    }));
  };
  const applyFilters = () => {
    const st = $('#ap-status').value;
    const t = $('#ap-type').value;
    $('#ap-after').style.display = t === 'course' ? '' : 'none';
    if (t !== 'course') $('#ap-after').value = '';
    const af = t === 'course' ? $('#ap-after').value : '';
    const te = $('#ap-teacher').value;
    const dt = $('#ap-date').value;
    const list = rows.filter((r) =>
      (!st || r.status === st) &&
      (!t || r.type === t) &&
      (!af || ((r.payload || {}).afterclass || '') === af) &&
      (!te || r.owner_name === te) &&
      (!dt || recBizTime(r).slice(0, 10) === dt));
    list.sort((a, b) => {
      const c = $('#ap-sort').value === 'asc'
        ? recBizTime(a).localeCompare(recBizTime(b))
        : recBizTime(b).localeCompare(recBizTime(a));
      return c !== 0 ? c : String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    $('#ap-count').textContent = `共 ${list.length} 条，已选 ${document.querySelectorAll('.ap-check:checked').length} 条`;
    $('#ap-list').innerHTML = list.length ? list.map((r) => {
      /* 超管专属（角色判定，users.role=superadmin）：任意状态记录可彻底删除（危险操作，仅超管可见） */
      const eraseBtn = isSuper() ? `<button class="btn sm red" data-erase="${r.id}">彻底删除</button>` : '';
      /* 同上：已核算/已退回记录可回退到待审核（财务误操作时纠正） */
      const revertBtn = (isSuper() && ['accounted', 'returned'].includes(r.status)) ? `<button class="btn sm ghost" data-revert="${r.id}" data-from="${r.status}">回退待审核</button>` : '';
      if (r.status !== flow.from) return recCard(r, revertBtn + eraseBtn);
      return `
      <div style="display:flex;gap:8px;align-items:flex-start">
        <input type="checkbox" class="ap-check" data-id="${r.id}" style="margin-top:16px;width:18px;height:18px;flex:none">
        <div style="flex:1;min-width:0">${recCard(r,
          `<button class="btn sm teal" data-pass="${r.id}">${flow.passLabel}</button>
           <button class="btn sm red" data-back="${r.id}">退回</button>${eraseBtn}`)}</div>
      </div>`;
    }).join('')
      : '<div class="empty">没有匹配筛选条件的记录</div>';
    $('#ap-all').checked = false;
    bindActions();
  };
  const refreshCount = () => {
    $('#ap-count').textContent = `共 ${document.querySelectorAll('#ap-list .rec').length} 条，已选 ${document.querySelectorAll('.ap-check:checked').length} 条`;
  };
  const refreshTeachers = () => {
    const keepTeacher = $('#ap-teacher').value;
    const st = $('#ap-status').value;
    const pool = st ? rows.filter((r) => r.status === st) : rows;
    const teachers = [...new Set(pool.map((r) => r.owner_name).filter(Boolean))].sort();
    $('#ap-teacher').innerHTML = '<option value="">全部教师</option>' + teachers.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if (keepTeacher && teachers.includes(keepTeacher)) $('#ap-teacher').value = keepTeacher;
  };
  async function load() {
    const keepY = window.scrollY;
    $('#ap-list').innerHTML = '<div class="loading-box">加载中…</div>';
    try {
      rows = unwrap(await db.from('records').select('*').eq('month', $('#ap-month').value).order('created_at', { ascending: false }).limit(5000)) || [];
    } catch (e) { toast('加载失败：' + e.message); rows = []; }
    refreshTeachers();
    applyFilters();
    window.scrollTo(0, keepY);
  }
  approveReload = load;
  ['ap-type', 'ap-after', 'ap-teacher', 'ap-sort', 'ap-date'].forEach((id) => $('#' + id).addEventListener('change', applyFilters));
  $('#ap-status').addEventListener('change', () => { refreshTeachers(); applyFilters(); });
  $('#ap-month').addEventListener('change', load);
  $('#ap-list').addEventListener('change', (e) => {
    if (e.target.classList.contains('ap-check')) refreshCount();
  });
  $('#ap-all').addEventListener('change', () => {
    document.querySelectorAll('.ap-check').forEach((c) => { c.checked = $('#ap-all').checked; });
    refreshCount();
  });
  $('#ap-batch').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('.ap-check:checked')].map((c) => c.dataset.id);
    if (!ids.length) { toast('请先勾选要审核的记录'); return; }
    if (!confirm(`确定将选中的 ${ids.length} 条记录全部审核通过？`)) return;
    const btn = $('#ap-batch'); btn.disabled = true; btn.textContent = '批量审核中…';
    let ok = 0, fail = 0;
    for (const id of ids) {
      const res = await db.from('records').update({ status: flow.pass, updated_at: new Date().toISOString() }).eq('id', id).select();
      (res.error || !(res.data || []).length) ? fail++ : ok++;
    }
    btn.disabled = false; btn.textContent = '批量审核通过';
    toast(`已审核通过 ${ok} 条${fail ? '，失败 ' + fail + ' 条' : ''}`);
    load();
  });
  await load();
}
/* 审核操作后的轻量刷新（由 renderApprove 注入，保留筛选状态与滚动位置；未注入则整页重建） */
let approveReload = null;
async function setStatus(id, status, label) {
  const res = await db.from('records').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select();
  if (res.error || !(res.data || []).length) toast('操作失败');
  else { toast('已' + label); if (approveReload) await approveReload(); else renderApprove(); }
}

/* ========== 财务汇总与导出 ========== */
async function renderFinance() {
  if (!canFinance()) { pageShell('财务汇总', '<div class="empty">仅财务/校长/超级管理员可见</div>', { tab: 'finance' }); return; }
  pageShell('财务汇总', `
    <div class="card">
      <div class="filter-bar">
        <input type="month" id="fin-month" value="${thisMonth()}">
        <select id="fin-campus"><option value="">全部校区</option>${CAMPUSES.map((c) => `<option>${c}</option>`).join('')}</select>
        <select id="fin-status"><option value="pending,accounted">待审核+已核算</option><option value="accounted">仅已核算</option><option value="pending">仅待审核</option></select>
      </div>
      <button class="btn sm" id="fin-query">查询汇总</button>
      <button class="btn sm ghost" id="fin-export">导出标准 Excel</button>
      ${canFinance() ? '<a class="btn sm ghost" href="#/params" style="text-decoration:none">核算参数维护</a>' : ''}
    </div>
    <div id="fin-result"></div>
  `, { tab: 'finance' });
  $('#fin-query').addEventListener('click', runFinanceQuery);
  $('#fin-export').addEventListener('click', () => runFinanceQuery(true));
}
let finCache = { records: [], params: [] };
async function runFinanceQuery(doExport) {
  const month = $('#fin-month').value;
  const campus = $('#fin-campus').value;
  const statuses = $('#fin-status').value.split(',');
  $('#fin-result').innerHTML = '<div class="loading-box">统计中…</div>';
  try {
    let q = db.from('records').select('*').eq('month', month).in('status', statuses).order('created_at');
    if (campus) q = q.eq('campus', campus);
    finCache.records = unwrap(await q) || [];
    finCache.params = unwrap(await db.from('params').select('*')) || [];
  } catch (e) { $('#fin-result').innerHTML = `<div class="empty">查询失败：${esc(e.message)}</div>`; return; }
  renderFinanceResult(month);
  if (doExport) exportFinanceExcel(finCache.records, finCache.params, month);
}
function renderFinanceResult(month) {
  const rs = finCache.records;
  const byType = {};
  rs.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
  const courseFee = calcCourseFee(rs, finCache.params);
  const commission = calcCommission(rs, finCache.params);
  $('#fin-result').innerHTML = `
    <div class="card"><h3>${esc(month)} 汇总（${rs.length} 条记录）</h3>
      <p class="muted">${Object.entries(byType).map(([k, v]) => `${TYPES[k] ? TYPES[k].name : k} ${v} 条`).join(' · ') || '暂无数据'}</p>
      <div class="sec-title">课时费合计：<b>¥${courseFee.total.toFixed(2)}</b></div>
      <div class="sec-title">学费提成合计：<b>¥${commission.tuitionTotal.toFixed(2)}</b></div>
      <div class="sec-title">物品/材料提成合计：<b>¥${commission.goodsTotal.toFixed(2)}</b></div>
    </div>
    <div class="card"><h3>课时费明细（按人）</h3><div class="tbl-wrap"><table class="tbl">
      <tr><th>姓名</th><th>课次</th><th>责任课时</th><th>计费课次</th><th>单价</th><th>课时费</th></tr>
      ${courseFee.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.count}</td><td>${r.duty}</td><td>${r.billable}</td><td>¥${r.price}</td><td><b>¥${r.fee.toFixed(2)}</b></td></tr>`).join('') || '<tr><td colspan="6">无数据</td></tr>'}
    </table></div></div>`;
}
/* 课时费：计费课次 = max(0, 课次 - 责任课时)；课时费 = min(计费课次 × 单价, 封顶)。无参数时按课次原样列出、金额待财务补 */
function calcCourseFee(rs, params) {
  const byPerson = {};
  rs.filter((r) => r.type === 'course').forEach((r) => {
    const k = r.owner_name || '未署名';
    byPerson[k] = byPerson[k] || { count: 0 };
    byPerson[k].count += 1;
  });
  let total = 0;
  const rows = Object.entries(byPerson).map(([name, v]) => {
    const pr = params.find((x) => x.member_name === name) || {};
    const duty = pr.duty_hours || 0;
    const price = pr.unit_price != null ? Number(pr.unit_price) : 0;
    const cap = pr.cap != null ? Number(pr.cap) : Infinity;
    const billable = Math.max(0, v.count - duty);
    const fee = Math.min(billable * price, cap);
    total += fee;
    return { name, count: v.count, duty, billable, price, fee };
  }).sort((a, b) => b.fee - a.fee);
  return { rows, total };
}
function calcCommission(rs, params) {
  let tuitionTotal = 0, goodsTotal = 0;
  rs.filter((r) => r.type === 'tuition').forEach((r) => {
    const pr = params.find((x) => x.member_name === (r.payload.commission_to || r.owner_name)) || {};
    const rate = pr.tuition_rate != null ? Number(pr.tuition_rate) : 0;
    tuitionTotal += (Number(r.payload.amount) || 0) * rate;
  });
  rs.filter((r) => r.type === 'goods').forEach((r) => {
    const pr = params.find((x) => x.member_name === r.owner_name) || {};
    const rate = pr.material_rate != null ? Number(pr.material_rate) : 0;
    goodsTotal += (Number(r.payload.amount) || 0) * rate;
  });
  return { tuitionTotal, goodsTotal };
}

/* ========== 核算参数维护（财务/领导） ========== */
async function renderParams() {
  const p = state.profile;
  if (!canFinance()) { pageShell('核算参数', '<div class="empty">仅财务/校长/超级管理员可见</div>', { tab: 'finance' }); return; }
  pageShell('核算参数维护', '<div class="loading-box">加载中…</div>', { tab: 'finance' });
  let rows = [];
  try { rows = unwrap(await db.from('params').select('*').order('member_name')) || []; } catch (e) { toast('加载失败'); }
  pageShell('核算参数维护', `
    <div class="card"><h3>人员核算参数</h3>
      <p class="hint">全职/兼职的课时单价、封顶、责任课时、提成比例。课时费=（课次-责任课时）×单价，不超过封顶。</p></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl">
      <tr><th>姓名</th><th>类型</th><th>单价</th><th>封顶</th><th>责任课时</th><th>学费提成%</th><th>物品提成%</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.member_name)}</td><td>${esc(r.employment || '')}</td><td>${r.unit_price ?? '-'}</td><td>${r.cap ?? '-'}</td><td>${r.duty_hours ?? '-'}</td><td>${r.tuition_rate != null ? (r.tuition_rate * 100).toFixed(1) : '-'}</td><td>${r.material_rate != null ? (r.material_rate * 100).toFixed(1) : '-'}</td><td><button class="btn sm ghost" data-edit='${JSON.stringify(r)}'>改</button></td></tr>`).join('') || '<tr><td colspan="8">暂无参数，请新增</td></tr>'}
    </table></div></div>
    <button class="btn" id="pm-add">新增人员参数</button>
  `, { tab: 'finance' });
  $('#pm-add').addEventListener('click', () => paramForm(null));
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => paramForm(JSON.parse(b.dataset.edit))));
}
function paramForm(r) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal"><h3>${r ? '编辑' : '新增'}核算参数</h3>
    <div class="field"><label>姓名（与填报人姓名一致）</label><input id="pf-name" value="${esc(r ? r.member_name : '')}"></div>
    <div class="field"><label>用工类型</label><div class="seg" id="pf-emp">
      ${['全职', '兼职', '助教'].map((x) => `<button type="button" data-v="${x}" class="${r && r.employment === x ? 'on' : ''}">${x}</button>`).join('')}</div></div>
    <div class="field"><label>课时单价（元/节）</label><input id="pf-price" type="number" step="0.01" value="${r && r.unit_price != null ? r.unit_price : ''}"></div>
    <div class="field"><label>课时费封顶（元）</label><input id="pf-cap" type="number" step="0.01" value="${r && r.cap != null ? r.cap : ''}"></div>
    <div class="field"><label>责任课时（节，前 N 节不计费）</label><input id="pf-duty" type="number" value="${r && r.duty_hours != null ? r.duty_hours : ''}"></div>
    <div class="field"><label>学费提成比例（%，如 2.5）</label><input id="pf-tuition" type="number" step="0.01" value="${r && r.tuition_rate != null ? r.tuition_rate * 100 : ''}"></div>
    <div class="field"><label>物品/材料提成比例（%）</label><input id="pf-material" type="number" step="0.01" value="${r && r.material_rate != null ? r.material_rate * 100 : ''}"></div>
    <button class="btn" id="pf-save">保存</button>
    <button class="btn ghost" id="pf-cancel">取消</button></div>`;
  document.body.appendChild(mask);
  segBind('#pf-emp');
  mask.querySelector('#pf-cancel').addEventListener('click', () => mask.remove());
  mask.querySelector('#pf-save').addEventListener('click', async () => {
    const name = mask.querySelector('#pf-name').value.trim();
    if (!name) { toast('请填写姓名'); return; }
    const val = (id, scale) => { const v = mask.querySelector(id).value; if (v === '') return null; return Number(v) * (scale || 1); };
    const row = {
      member_name: name, employment: segVal('#pf-emp') || null,
      unit_price: val('#pf-price'), cap: val('#pf-cap'), duty_hours: val('#pf-duty'),
      tuition_rate: val('#pf-tuition', 0.01), material_rate: val('#pf-material', 0.01),
    };
    const res = r
      ? await db.from('params').update(row).eq('id', r.id).select()
      : await db.from('params').insert(row).select();
    if (res.error) toast('保存失败：' + res.error.message);
    else { toast('已保存'); mask.remove(); renderParams(); }
  });
}

boot();
