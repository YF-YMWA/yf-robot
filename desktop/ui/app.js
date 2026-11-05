/* =========================================================
   ENbot 启动器前端
   与 C# 宿主通过 chrome.webview.hostObjects.launcher 通信；
   没有宿主时（直接用浏览器打开 / 截图预览）退化为演示数据。
   ========================================================= */

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const bridge = (() => {
    try {
      const ho = window.chrome && window.chrome.webview && window.chrome.webview.hostObjects;
      return ho && ho.launcher ? ho.launcher : null;
    } catch { return null; }
  })();

  const demoParam = new URLSearchParams(location.search).has('demo');
  const DEMO = !bridge || demoParam;

  const state = {
    version: '—',
    port: '—',
    serviceUp: false,
    adapterOnline: null,
    autoStart: false,
    trayLog: [],
    base: '',
  };

  let plugins = [];
  let market = [];
  let pluginFilter = '';
  let updateChecked = false;
  let busy = false;

  /* ========================= 宿主调用 ========================= */

  async function call(name, ...args) {
    if (DEMO && !bridge) return mock(name, args);
    if (!bridge) return null;
    try {
      const raw = await bridge[name](...args);
      return raw == null ? null : String(raw);
    } catch (err) {
      console.warn('[bridge]', name, err);
      return null;
    }
  }

  async function act(action, arg = '') {
    const raw = await call('Act', action, arg);
    if (!raw) return { ok: false, error: '后台没有响应' };
    try { return JSON.parse(raw); } catch { return { ok: false, error: raw }; }
  }

  /* ========================= 演示数据 ========================= */

  function mock(name, args) {
    const now = new Date();
    const ts = (offset) => {
      const d = new Date(now.getTime() - offset * 1000);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    if (name === 'GetState') {
      return JSON.stringify({
        version: '0.9.24',
        port: 8899,
        serviceUp: true,
        adapterOnline: true,
        autoStart: false,
        base: 'http://127.0.0.1:8899',
        trayLog: [
          `${ts(184)}  托盘启动（版本 0.9.24，端口 8899）`,
          `${ts(182)}  服务已启动 pid=19468`,
          `${ts(9)}  [state] False -> True`,
          `${ts(4)}  适配器已连接`,
        ],
      });
    }
    if (name === 'GetPlugins') {
      return JSON.stringify({
        plugins: [
          { id: 'dice-notes', name: '掷骰子与便签', version: '1.0.0', state: 'loaded', tools: 'roll_dice, note' },
          { id: 'weather', name: '天气查询', version: '0.4.2', state: 'loaded', tools: 'get_weather' },
          { id: 'old-bridge', name: '旧版微信桥接', version: '0.1.0', state: 'disabled', tools: '' },
        ],
      });
    }
    if (name === 'GetMarket') {
      return JSON.stringify({
        items: [
          { id: 'demo-dice-notes', name: '示例插件 · 掷骰子与便签', version: '1.0.0', description: '仓库自带的示例插件，演示工具注册、记忆读写与角色卡联动。', download: '' },
          { id: 'web-digest', name: '网页摘要', version: '0.3.1', description: '把网页正文收进知识库，支持按角色卡隔离与去重。', download: 'https://example.com/web-digest.zip' },
        ],
      });
    }
    if (name === 'CheckUpdate') {
      return JSON.stringify({ local: '0.9.24', latest: '0.9.24', hasUpdate: false });
    }
    if (name === 'Act') {
      if (args[0] === 'update') return mock('CheckUpdate');
      return JSON.stringify({ ok: true });
    }
    return null;
  }

  /* ========================= 小工具 ========================= */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;

  function toast(kind, title, sub, ms = 3800) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const ic = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info';
    el.innerHTML = `${icon(ic)}<div class="tt"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  let modalResolve = null;

  function confirmDialog({ title, text, okText = '确定', danger = true }) {
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text || '';
    $('#modalOk').textContent = okText;
    $('#modalIcon').className = 'modal-ic' + (danger ? ' danger' : '');
    $('#modal').hidden = false;
    $('#modalOk').focus();
    return new Promise((resolve) => { modalResolve = resolve; });
  }

  function closeModal(result) {
    if ($('#modal').hidden) return;
    $('#modal').hidden = true;
    const r = modalResolve;
    modalResolve = null;
    if (r) r(result);
  }

  /* ========================= 状态渲染 ========================= */

  function setDot(el, cls) {
    if (!el) return;
    el.classList.remove('ok', 'bad', 'busy', 'checking');
    el.classList.add(cls);
  }

  function renderState() {
    const up = !!state.serviceUp;
    const adapterKnown = state.adapterOnline !== null && state.adapterOnline !== undefined;
    const adapterOn = state.adapterOnline === true;

    $('#brandVer').textContent = 'v' + state.version;
    $('#sideVer').textContent = `ENbot · v${state.version} · 本地面板`;

    // 标题栏
    setDot($('#titleStatus .dot'), up ? 'ok' : 'bad');
    $('#titleStatusText').textContent = up
      ? `服务运行中 · 127.0.0.1:${state.port}`
      : '服务未运行';

    // 侧栏迷你状态
    setDot($('#miniStatus .dot'), up ? 'ok' : 'bad');
    $('#miniTitle').textContent = up ? '服务运行中' : '服务已停止';
    $('#miniSub').textContent = `127.0.0.1:${state.port}`;

    // Hero
    setDot($('#heroDot'), up ? 'ok' : 'bad');
    $('#heroTitle').textContent = up ? '运行中' : '服务已停止';
    $('#heroDesc').textContent = up
      ? (adapterKnown && adapterOn
        ? '本地服务已就绪，微信适配器已接入。'
        : '本地服务已就绪，微信适配器未接入（只影响微信收发）。')
      : '启动本地服务后，控制台、聊天与微信收发才可用。';
    $('#heroAddr').textContent = `127.0.0.1:${state.port}`;
    $('#heroVer').textContent = `v${state.version}`;
    $('#heroAuto').textContent = `开机自启 ${state.autoStart ? '已开启' : '未开启'}`;

    $('#btnStart').hidden = up;
    $('#btnRestart').disabled = !up;
    $('#btnStop').disabled = !up;

    // 统计
    const adp = $('#statAdapter');
    adp.textContent = !up ? '未知' : (adapterOn ? '已接入' : '未接入');
    adp.className = 'v' + (!up ? ' muted' : adapterOn ? ' ok' : ' muted');
    $('#statAdapterHint').textContent = !up ? '服务未就绪' : '微信收发通道';
    $('#statPort').textContent = state.port;
    $('#statAuto').textContent = state.autoStart ? '已开启' : '未开启';
    $('#statAuto').className = 'v' + (state.autoStart ? ' ok' : ' muted');

    // 设置页
    $('#setVersion').textContent = 'v' + state.version;
    const sw = $('#swAuto');
    sw.classList.toggle('on', !!state.autoStart);
    sw.setAttribute('aria-checked', String(!!state.autoStart));

    renderTrayLog(state.trayLog || []);
  }

  function renderTrayLog(lines) {
    const box = $('#trayLog');
    if (!lines.length) {
      box.innerHTML = '<span class="ln">还没有活动记录。</span>';
      return;
    }
    box.innerHTML = lines.slice(-14).map((line) => {
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/.exec(line);
      if (!m) return `<div>${esc(line)}</div>`;
      return `<div><span class="ln">${esc(m[1])}</span>  <span class="hi">${esc(m[2])}</span></div>`;
    }).join('');
  }

  /* ========================= 刷新 ========================= */

  async function refreshState() {
    const raw = await call('GetState');
    if (!raw) {
      if (!DEMO) $('#titleStatusText').textContent = '与后台失联';
      return;
    }
    try { Object.assign(state, JSON.parse(raw)); } catch { return; }
    renderState();
  }

  async function refreshPlugins() {
    const raw = await call('GetPlugins');
    const list = $('#pluginList');
    if (!raw) {
      list.innerHTML = emptyBlock('读不到插件列表', '服务没起来，或者接口不可用。');
      $('#pluginCount').textContent = '—';
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      list.innerHTML = emptyBlock('插件列表格式异常', '返回内容不是合法 JSON。');
      return;
    }
    if (data.error) {
      list.innerHTML = emptyBlock('读不到插件列表', data.error);
      $('#pluginCount').textContent = '—';
      return;
    }
    plugins = Array.isArray(data.plugins) ? data.plugins : [];
    $('#navPluginCount').textContent = plugins.length ? String(plugins.length) : '';
    $('#statPlugins').textContent = plugins.length ? String(plugins.length) : '0';
    renderPlugins();
  }

  function pluginSwitch(p, on) {
    return `<button class="switch sm ${on ? 'on' : ''}" role="switch" aria-checked="${on}"
              data-plugin="${esc(p.id || '')}" data-enabled="${on}" aria-label="启用或停用插件"><i></i></button>`;
  }

  function renderPlugins() {
    const list = $('#pluginList');
    const q = pluginFilter.trim().toLowerCase();
    const rows = plugins.filter((p) => {
      if (!q) return true;
      return [p.name, p.id, p.tools, p.version].some((v) => String(v || '').toLowerCase().includes(q));
    });

    $('#pluginCount').textContent = plugins.length
      ? (q ? `${rows.length} / ${plugins.length} 个插件` : `${plugins.length} 个插件`)
      : '暂无插件';

    if (!plugins.length) {
      list.innerHTML = emptyBlock('还没有插件', '把插件文件夹放到 plugins/ 目录，然后点刷新。');
      return;
    }
    if (!rows.length) {
      list.innerHTML = emptyBlock('没有匹配的插件', '换个关键词试试。');
      return;
    }

    list.innerHTML = rows.map((p) => {
      const on = p.state === 'loaded' || p.state === 'enabled' || p.enabled === true;
      const name = p.name || p.id || '未命名插件';
      const letter = String(name).trim().charAt(0).toUpperCase();
      const tools = p.tools
        ? (Array.isArray(p.tools) ? p.tools.join(', ') : String(p.tools))
        : '';
      return `<div class="plugin">
        <div class="p-ico">${esc(letter)}</div>
        <div class="p-main">
          <div class="p-name">${esc(name)}</div>
          <div class="p-sub">
            <span class="mono">${esc(p.id || '')}</span>
            ${p.version ? `<span>v${esc(p.version)}</span>` : ''}
            ${tools ? `<span class="p-tools" title="${esc(tools)}">工具：${esc(tools)}</span>` : '<span>无工具</span>'}
          </div>
        </div>
        <span class="badge ${on ? 'ok' : 'off'}">${on ? '已启用' : '已停用'}</span>
        ${pluginSwitch(p, on)}
      </div>`;
    }).join('');
  }

  async function refreshMarket() {
    const grid = $('#marketGrid');
    const empty = $('#marketEmpty');
    const raw = await call('GetMarket');
    let items = [];
    if (raw) {
      try {
        const data = JSON.parse(raw);
        items = Array.isArray(data.items) ? data.items : [];
      } catch { items = []; }
    }
    market = items;
    if (!items.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = items.map((it, i) => {
      const name = it.name || it.id || '未命名插件';
      const letter = String(name).trim().charAt(0).toUpperCase();
      const canInstall = !!(it.download && String(it.download).trim());
      return `<div class="mcard">
        <div class="mcard-top">
          <div class="p-ico">${esc(letter)}</div>
          <div class="mcard-name">
            <b>${esc(name)}</b>
            <small>${it.version ? 'v' + esc(it.version) : ''}${it.author ? ' · ' + esc(it.author) : ''}</small>
          </div>
        </div>
        <p class="mcard-desc">${esc(it.description || '没有填写说明。')}</p>
        <div class="mcard-foot">
          <span class="hint">${canInstall ? '下载后解压到 plugins/' : '随包提供，无需下载'}</span>
          <button class="btn ${canInstall ? '' : 'ghost'} sm" data-install="${i}" ${canInstall ? '' : 'disabled'}>
            ${canInstall ? icon('download') + '安装' : icon('check') + '已内置'}
          </button>
        </div>
      </div>`;
    }).join('');
  }

  function emptyBlock(title, sub) {
    return `<div class="empty" style="border:0;padding:26px 10px">
      <span class="empty-ic">${icon('box')}</span>
      <b>${esc(title)}</b>
      <p>${esc(sub)}</p>
    </div>`;
  }

  /* ========================= 动作 ========================= */

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    document.body.classList.add('busy');
    try { await fn(); } finally { busy = false; document.body.classList.remove('busy'); }
  }

  async function startService() {
    if (busy) return;
    $('#btnStart').disabled = true;
    const r = await act('start');
    if (!r.ok) { toast('err', '启动失败', r.error); $('#btnStart').disabled = false; return; }
    toast('info', '正在启动服务…', '就绪后状态会自动更新。');
    setTimeout(refreshState, 900);
    setTimeout(refreshState, 2200);
    setTimeout(() => { $('#btnStart').disabled = false; }, 2500);
  }

  async function stopService() {
    const ok = await confirmDialog({
      title: '停止本地服务？',
      text: '聊天与微信收发会立刻中断，托盘和启动器仍然保留。',
      okText: '停止服务',
    });
    if (!ok) return;
    const r = await act('stop');
    toast(r.ok ? 'ok' : 'err', r.ok ? '服务已停止' : '停止失败', r.ok ? '需要时可以在概览页重新启动。' : r.error);
    setTimeout(refreshState, 700);
  }

  async function restartService() {
    const ok = await confirmDialog({
      title: '重启本地服务？',
      text: '正在进行的对话会中断，大约 2–5 秒后恢复。',
      okText: '重启',
      danger: false,
    });
    if (!ok) return;
    const r = await act('restart');
    if (!r.ok) { toast('err', '重启失败', r.error); return; }
    toast('info', '正在重启服务…', '稍等几秒，状态会自动更新。');
    setTimeout(refreshState, 1200);
    setTimeout(refreshState, 3000);
  }

  async function backupMemory() {
    const r = await act('backup');
    if (!r.ok) { toast('err', '备份失败', r.error); return; }
    toast('info', '正在备份记忆…', '完成后会提示结果。');
  }

  async function restoreMemory() {
    const ok = await confirmDialog({
      title: '恢复最近备份？',
      text: '当前记忆和会话会被快照覆盖。恢复前会再自动存一份，备份文件本身不会删。',
      okText: '恢复备份',
    });
    if (!ok) return;
    const r = await act('restore');
    if (!r.ok) { toast('err', '恢复失败', r.error); return; }
    toast('info', '正在恢复记忆…', '完成后会提示结果。');
  }

  async function openApp(which) {
    if (!state.serviceUp && which !== 'browser') {
      toast('err', '服务未运行', '先在概览页启动本地服务。');
      return;
    }
    const r = await act('open', which);
    if (!r.ok) toast('err', '打开失败', r.error);
  }

  async function checkUpdate() {
    const box = $('#btnUpdate');
    const hint = $('#updateHint');
    box.disabled = true;
    hint.textContent = '正在检查…';
    const raw = await call('CheckUpdate');
    box.disabled = false;
    updateChecked = true;
    if (!raw) { hint.textContent = '检查失败：后台没有响应。'; return; }
    let d = {};
    try { d = JSON.parse(raw); } catch { hint.textContent = '检查失败：返回格式异常。'; return; }
    if (d.error) { hint.textContent = '检查失败：' + d.error; return; }
    if (d.hasUpdate) {
      hint.textContent = `发现新版本 ${d.latest || ''}（当前 ${d.local || state.version}）。`;
      toast('info', '有新版本可用', `最新 ${d.latest || ''}`);
    } else {
      hint.textContent = `已是最新版本（${d.local || state.version}）。`;
      toast('ok', '已是最新版本', `v${d.local || state.version}`);
    }
  }

  async function toggleAuto() {
    const next = !state.autoStart;
    const sw = $('#swAuto');
    sw.disabled = true;
    const r = await act('autoStart', next ? 'true' : 'false');
    sw.disabled = false;
    if (!r.ok) { toast('err', '设置失败', r.error); return; }
    state.autoStart = !!r.autoStart;
    renderState();
    toast('ok', next ? '已开启开机自启' : '已关闭开机自启', next ? '下次登录 Windows 会驻留托盘。' : '');
  }

  async function togglePlugin(id, enabled, btn) {
    btn.disabled = true;
    const r = await act('togglePlugin', `${id}|${enabled ? 'false' : 'true'}`);
    if (!r.ok) { btn.disabled = false; toast('err', '操作失败', r.error || '服务没起来？'); return; }
    toast('ok', enabled ? '插件已停用' : '插件已启用', '重启服务后生效。');
    await refreshPlugins();
  }

  async function installPlugin(index, btn) {
    const it = market[index];
    if (!it) return;
    if (!it.download) { toast('info', '这个插件随包提供', '不需要下载。'); return; }
    const ok = await confirmDialog({
      title: `安装「${it.name || it.id}」？`,
      text: '会下载压缩包并解压到 plugins/ 目录，安装后需要重启服务生效。',
      okText: '安装',
      danger: false,
    });
    if (!ok) return;
    btn.disabled = true;
    btn.innerHTML = `${icon('download')}下载中…`;
    const r = await act('install', `${it.id || ''}|${it.download}`);
    if (!r.ok) {
      btn.disabled = false;
      btn.innerHTML = `${icon('download')}安装`;
      toast('err', '安装失败', r.error);
      return;
    }
    toast('info', '正在下载并解压…', '完成后会提示结果。');
  }

  /* ========================= 导航 ========================= */

  function showPage(name) {
    $$('.nav-item[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
    $('#main').scrollTop = 0;

    if (name === 'plugins') refreshPlugins();
    if (name === 'market') refreshMarket();
    if (name === 'overview') { refreshState(); refreshPluginsCount(); }
  }

  async function refreshPluginsCount() {
    const raw = await call('GetPlugins');
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      const n = Array.isArray(d.plugins) ? d.plugins.length : 0;
      $('#statPlugins').textContent = String(n);
      $('#navPluginCount').textContent = n ? String(n) : '';
    } catch { /* ignore */ }
  }

  /* ========================= 事件绑定 ========================= */

  function bind() {
    // 窗口按钮
    $('#winMin').addEventListener('click', () => call('Window', 'min'));
    $('#winMax').addEventListener('click', () => call('Window', 'max'));
    $('#winClose').addEventListener('click', () => call('Window', 'close'));

    // 拖动 / 双击最大化
    // 不在 mousedown 立刻拖动：先等鼠标真的移动几像素，
    // 否则双击标题栏会被拖动循环吃掉，最大化永远触发不了。
    const titlebar = $('#titlebar');
    titlebar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;

      const start = { x: e.screenX, y: e.screenY };
      let active = true;

      const onMove = (ev) => {
        if (!active) return;
        if (Math.abs(ev.screenX - start.x) + Math.abs(ev.screenY - start.y) < 4) return;
        active = false;
        cleanup();
        call('Window', 'drag');
      };
      const onUp = () => {
        active = false;
        cleanup();
      };
      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    titlebar.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      call('Window', 'max');
    });

    // 导航
    $$('.nav-item[data-page]').forEach((b) => {
      b.addEventListener('click', () => showPage(b.dataset.page));
    });
    $$('.nav-item[data-open]').forEach((b) => {
      b.addEventListener('click', () => openApp(b.dataset.open));
    });

    // 概览动作
    $('#btnStart').addEventListener('click', startService);
    $('#btnStop').addEventListener('click', stopService);
    $('#btnRestart').addEventListener('click', restartService);

    $$('.quick[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'console' || a === 'chat') return openApp(a);
        if (a === 'logs') return call('Act', 'logs');
        if (a === 'data') return call('Act', 'data');
        if (a === 'backup') return backupMemory();
        if (a === 'restore') return restoreMemory();
      });
    });

    $('#btnLogs').addEventListener('click', () => call('Act', 'logs'));

    // 插件页
    $('#btnPluginReload').addEventListener('click', refreshPlugins);
    $('#btnPluginDir').addEventListener('click', () => call('Act', 'pluginsDir'));
    $('#btnRestartFromPlugins').addEventListener('click', restartService);
    $('#pluginSearch').addEventListener('input', (e) => {
      pluginFilter = e.target.value;
      renderPlugins();
    });
    $('#pluginList').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-plugin]');
      if (!sw) return;
      togglePlugin(sw.dataset.plugin, sw.dataset.enabled === 'true', sw);
    });

    // 市场页
    $('#btnMarketReload').addEventListener('click', refreshMarket);
    $('#btnMarketDir').addEventListener('click', () => call('Act', 'marketDir'));
    $('#btnMarketEdit').addEventListener('click', () => call('Act', 'marketEdit'));
    $('#marketGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-install]');
      if (!b) return;
      installPlugin(Number(b.dataset.install), b);
    });

    // 设置页
    $('#swAuto').addEventListener('click', toggleAuto);
    $('#btnUpdate').addEventListener('click', checkUpdate);
    $('#btnGithub').addEventListener('click', () => call('Act', 'github'));
    $('#btnAboutData').addEventListener('click', () => call('Act', 'data'));

    // 弹窗
    $('#modalCancel').addEventListener('click', () => closeModal(false));
    $('#modalOk').addEventListener('click', () => closeModal(true));
    $('#modal').addEventListener('mousedown', (e) => {
      if (e.target === $('#modal')) closeModal(false);
    });

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return closeModal(false);
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const pages = ['overview', 'plugins', 'market', 'settings'];
      const n = Number(e.key);
      if (n >= 1 && n <= 4) { e.preventDefault(); showPage(pages[n - 1]); }
    });
  }

  /* ========================= 启动 ========================= */

  async function boot() {
    bind();

    if (DEMO && !bridge) {
      $('#titleStatusText').textContent = '演示模式 · 未连接后台';
    }

    // 后台任务结果（备份 / 恢复 / 安装）
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || m.type !== 'result') return;
        if (m.busy) return;
        toast(m.ok ? 'ok' : 'err', m.title || (m.ok ? '完成' : '失败'), m.text || '');
        if (m.refresh === 'plugins') refreshPlugins();
      });
    }

    document.body.classList.add('ready');
    await refreshState();
    await refreshPluginsCount();

    // 便于截图 / 深链：index.html?page=plugins
    const wanted = new URLSearchParams(location.search).get('page');
    if (wanted && $(`.page[data-page="${wanted}"]`)) showPage(wanted);

    setInterval(refreshState, 4000);
    setInterval(() => { if ($('.page[data-page="overview"]').classList.contains('active')) refreshPluginsCount(); }, 15000);
  }

  boot();
})();
