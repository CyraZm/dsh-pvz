// DSH × 植物大战僵尸 —— client 侧
// 全局浮窗（跨会话只有一个游戏实例）+ 左侧栏入口 + 围绕游戏的 AI 管理面板。
window.__ModuleLoader__.load({
  id: '@local/dsh-pvz',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const LS_KEY = 'dsh-pvz:window';
    const ICON = { 1: '🌱', 2: '🌻', 3: '🍒', 4: '🌰', 5: '🥔', 6: '❄️', 7: '🌺', 8: '🌿', 19: '🍀', 24: '🌳' };
    const APP_ID = 'dsh-pvz';

    // ---------- 全局小状态机（跨会话共享同一个窗口/同一局游戏） ----------
    const defaults = { open: false, min: false, x: null, y: null, w: 980, h: 640 };
    let state = Object.assign({}, defaults);
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && typeof saved === 'object') state = Object.assign(state, saved);
    } catch (e) {
      /* ignore */
    }
    const subs = new Set();
    function patch(p) {
      state = Object.assign({}, state, p);
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
      } catch (e) {
        /* ignore */
      }
      subs.forEach((f) => f());
    }
    function useWin() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const f = () => force((n) => n + 1);
        subs.add(f);
        return () => subs.delete(f);
      }, []);
      return state;
    }

    // 当前页面里的游戏实例 id（由 iframe 里的 Godot 通过 postMessage 送上来）。
    // 面板只关心「本页这一局」，别的标签页跑的另一局和我们无关。
    let instId = '';
    let pendingStart = false;
    try {
      window.addEventListener('message', (ev) => {
        const d = ev && ev.data;
        if (!d || d.source !== 'dsh-pvz' || !d.data) return;
        if (d.data.inst && d.data.inst !== instId) {
          instId = String(d.data.inst);
          if (pendingStart) { pendingStart = false; ctl('start'); }
        }
      });
    } catch (e) {
      /* ignore */
    }

    async function ctl(action, extra) {
      try {
        const r = await fetch('/dsh-pvz/ctl', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ action, inst: instId }, extra || {})),
        });
        return await r.json();
      } catch (e) {
        return { ok: false, err: String((e && e.message) || e) };
      }
    }

    function useGame() {
      const [snap, setSnap] = React.useState({ state: null, meta: null });
      React.useEffect(() => {
        let stop = false;
        let timer = null;
        const poll = async () => {
          try {
            const q = instId ? `?inst=${encodeURIComponent(instId)}` : '';
            const j = await (await fetch('/dsh-pvz/state' + q, { cache: 'no-store' })).json();
            if (!stop) setSnap(j);
          } catch (e) {
            /* ignore */
          }
          if (!stop) timer = setTimeout(poll, 800);
        };
        poll();
        return () => {
          stop = true;
          if (timer) clearTimeout(timer);
        };
      }, []);
      return snap;
    }

    // ---------- 样式（一次注入，.pvz- 前缀，不污染宿主） ----------
    const CSS = `
.pvz-win{position:fixed;z-index:2147483000;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;
  background:linear-gradient(165deg,#1c2418 0%,#12180f 38%,#0a0e08 100%);
  border:1px solid rgba(255,255,255,.13);color:#e9f0e4;
  box-shadow:0 48px 140px rgba(0,0,0,.72),0 10px 32px rgba(0,0,0,.5),0 0 0 1px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09);
  font:12.5px/1.5 -apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.pvz-bar{height:46px;flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:0 12px;user-select:none;
  background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.015));
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid rgba(255,255,255,.07);cursor:grab}
.pvz-bar.dragging{cursor:grabbing}
.pvz-dots{display:flex;gap:8px;margin-right:2px}
.pvz-dot{width:12px;height:12px;border-radius:50%;border:0;padding:0;cursor:pointer;position:relative;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.22);transition:filter .15s}
.pvz-dot:hover{filter:brightness(1.18)}
.pvz-dot.c{background:#ff5f57}.pvz-dot.m{background:#febc2e}.pvz-dot.f{background:#28c840}
.pvz-dot::after{position:absolute;inset:0;display:grid;place-items:center;font-size:9px;line-height:1;
  color:rgba(0,0,0,.55);opacity:0;transition:opacity .12s;font-weight:700}
.pvz-dots:hover .pvz-dot::after{opacity:1}
.pvz-dot.c::after{content:'×'}
.pvz-off{display:grid;place-items:center;color:#8a9a80;font-size:12.5px;background:radial-gradient(60% 60% at 50% 40%,#1b2417,#0d110b)}.pvz-dot.m::after{content:'–'}.pvz-dot.f::after{content:'+'}
.pvz-t{font-size:13px;font-weight:650;letter-spacing:.01em;color:#f0f5ec}
.pvz-t small{font-weight:400;font-size:11px;color:#7f9077;margin-left:8px;letter-spacing:.04em}
.pvz-sp{flex:1}
.pvz-main{flex:1;min-height:0;display:flex}
.pvz-stage{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:10px;
  background:radial-gradient(80% 70% at 50% 40%,#0e1510 0%,#050705 100%)}
.pvz-frame{width:100%;height:100%;border:0;border-radius:10px;background:#000;display:block;
  box-shadow:0 0 0 1px rgba(255,255,255,.07),0 18px 50px rgba(0,0,0,.55)}
.pvz-side{width:250px;flex:0 0 auto;display:flex;flex-direction:column;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent;
  border-left:1px solid rgba(255,255,255,.07);
  background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0) 55%)}
.pvz-side-hd{display:flex;align-items:center;gap:9px;padding:14px 14px 12px;position:relative}
.pvz-side::before{content:'';position:absolute;right:0;top:0;width:276px;height:120px;pointer-events:none;
  background:radial-gradient(120% 100% at 100% 0%,rgba(126,217,87,.09),transparent 70%)}
.pvz-av{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;font-size:14px;
  background:linear-gradient(145deg,#8ce06a,#3f9a45);box-shadow:0 6px 16px rgba(110,200,90,.28),inset 0 1px 0 rgba(255,255,255,.35)}
.pvz-nm{font-size:12.5px;font-weight:650;color:#eef4ea}
.pvz-sub{font-size:10.5px;color:#7f9077;letter-spacing:.02em}
.pvz-live{width:7px;height:7px;border-radius:50%;background:#7ed957;margin-left:auto;
  box-shadow:0 0 0 0 rgba(126,217,87,.6);animation:pvzp 1.8s ease-out infinite}
.pvz-live.off{background:#5b6a55;animation:none;box-shadow:none}
@keyframes pvzp{0%{box-shadow:0 0 0 0 rgba(126,217,87,.55)}70%{box-shadow:0 0 0 7px rgba(126,217,87,0)}100%{box-shadow:0 0 0 0 rgba(126,217,87,0)}}
.pvz-choose{display:flex;align-items:center;gap:8px;justify-content:space-between;margin:2px 14px 8px;padding:7px 9px;border-radius:9px;
  background:rgba(126,217,87,.1);border:1px solid rgba(126,217,87,.28);font-size:11px;color:#cfe6c2}
.pvz-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:0 14px 4px}
.pvz-stat{border-radius:10px;padding:7px 9px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.06)}
.pvz-stat b{display:block;font-size:17px;font-weight:680;letter-spacing:-.03em;color:#f4f9f0;font-variant-numeric:tabular-nums}
.pvz-stat span{display:block;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#7f9077;margin-top:1px}
.pvz-wave{display:flex;align-items:center;gap:8px;padding:0 14px;margin:8px 0 2px}
.pvz-wave-track{flex:1;height:6px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;position:relative}
.pvz-wave-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#7ed957,#c8f08a);box-shadow:0 0 10px rgba(126,217,87,.5);transition:width .3s ease}
.pvz-wave-txt{font-size:10px;color:#8fa185;font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
.pvz-tabs{display:flex;gap:6px;padding:0 14px;margin:0 0 9px}
.pvz-tab{flex:1;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#a9b8a2;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
.pvz-tab:hover{color:#e9f0e4;background:rgba(255,255,255,.07)}
.pvz-tab.on{background:linear-gradient(180deg,rgba(126,217,87,.22),rgba(126,217,87,.12));border-color:rgba(126,217,87,.45);color:#d6f6c2}
.pvz-win-note{display:flex;align-items:center;gap:8px;margin:8px 14px 0;padding:7px 9px;border-radius:8px;background:rgba(126,217,87,.12);border:1px solid rgba(126,217,87,.3);color:#c8ecb2;font-size:11px}
.pvz-line{padding:2px 0;line-height:1.5}
.pvz-line.who-ai{color:#cbe7ba}
.pvz-line.who-err{color:#f0a08a}
.pvz-h{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:#75866c;padding:0 14px;margin:15px 0 7px}
.pvz-row{display:flex;gap:6px;align-items:center;padding:0 14px}
.pvz-btn.wide{width:calc(100% - 28px);align-self:flex-start}
.pvz-btn{flex:1;min-width:0;white-space:nowrap;height:30px;padding:0 8px;border-radius:9px;border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.055);color:#e7efe2;font:inherit;font-size:12px;cursor:pointer;
  transition:background .15s,border-color .15s,transform .06s}
.pvz-btn:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.2)}
.pvz-btn:active{transform:translateY(1px)}
.pvz-btn.primary{background:linear-gradient(180deg,#93e572,#4fae3f);border-color:#6ac455;color:#0b1706;font-weight:650;
  box-shadow:0 8px 20px rgba(105,196,84,.25),inset 0 1px 0 rgba(255,255,255,.35)}
.pvz-btn.primary:hover{background:linear-gradient(180deg,#a0ee7e,#59bb47)}
.pvz-btn.on{background:linear-gradient(180deg,#ffc25c,#e58a12);border-color:#f2a83c;color:#26150a;font-weight:650;
  box-shadow:0 8px 20px rgba(230,150,30,.22)}
.pvz-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11px;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.085);color:#dfe8da}
.pvz-chip.mute{opacity:.5}
.pvz-side::-webkit-scrollbar{width:6px}
.pvz-side::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:99px}
.pvz-sec{font-size:10.5px;color:#8b9b83;min-width:26px;text-align:right}
.pvz-log{flex:0 0 auto;max-height:210px;overflow:auto;padding:0 14px 14px;font-size:11.5px;line-height:1.65;color:#9fb097;
  white-space:pre-wrap;word-break:break-word}
.pvz-log em{font-style:normal;color:#6f8067}
.pvz-lv{display:flex;align-items:baseline;gap:7px;margin:10px 14px 0;padding:7px 10px;border-radius:9px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.06)}
.pvz-lv-n{font-size:13px;font-weight:650;color:#eaf3e4}
.pvz-lv-w{font-size:10.5px;color:#8fa085}
.pvz-lv-p{margin-left:auto;font-size:10.5px;color:#7fd956;font-variant-numeric:tabular-nums}
.pvz-mini{margin-left:auto;font-size:9.5px;color:#7f9076;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:1px 6px}
.pvz-mini:hover{color:#cfe8bd;border-color:rgba(126,217,87,.4)}
.pvz-map{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin:2px 14px 6px}
.pvz-cell{aspect-ratio:1;display:grid;place-items:center;border-radius:5px;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.05);color:#9fb094;font-size:9.5px;cursor:pointer;padding:0;font-variant-numeric:tabular-nums}
.pvz-cell:hover:not(:disabled){background:rgba(126,217,87,.18);color:#e8f5df}
.pvz-cell:disabled{opacity:.28;cursor:not-allowed}
.pvz-cell.done{background:rgba(126,217,87,.16);border-color:rgba(126,217,87,.35);color:#a8e88a}
.pvz-cell.cur{background:#7ed956;border-color:#9ae86f;color:#10240b;font-weight:700;box-shadow:0 0 0 2px rgba(126,217,87,.22)}
.pvz-note{margin:auto 14px 14px;font-size:10.5px;line-height:1.6;color:#68775f;border-top:1px dashed rgba(255,255,255,.08);padding-top:9px}
.pvz-range{-webkit-appearance:none;appearance:none;flex:0 0 64px;height:3px;border-radius:99px;background:rgba(255,255,255,.14);outline:0}
.pvz-range::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;
  background:#e8f3e2;border:2px solid #64b84e;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:pointer}
.pvz-grab{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;z-index:3}
.pvz-grab::after{content:'';position:absolute;right:4px;bottom:4px;width:9px;height:9px;
  border-right:2px solid rgba(255,255,255,.22);border-bottom:2px solid rgba(255,255,255,.22);border-radius:0 0 3px 0}
.pvz-pill{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;
  padding:9px 15px 9px 12px;border-radius:999px;cursor:pointer;color:#0e1a08;font-weight:650;font-size:12.5px;
  border:1px solid rgba(255,255,255,.35);background:linear-gradient(180deg,#a7ee87,#5cbb47);
  box-shadow:0 14px 34px rgba(0,0,0,.45),0 4px 12px rgba(105,196,84,.3),inset 0 1px 0 rgba(255,255,255,.5);
  transition:transform .12s,box-shadow .2s;font-family:-apple-system,system-ui,"PingFang SC",sans-serif}
.pvz-pill:hover{transform:translateY(-1px);box-shadow:0 18px 40px rgba(0,0,0,.5),0 6px 16px rgba(105,196,84,.35)}
.pvz-entry{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:8px;
  background:transparent;border:0;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;text-align:left}
.pvz-entry:hover{background:rgba(127,127,127,.14)}
.pvz-entry .e{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:13px;
  background:linear-gradient(145deg,#8ce06a,#3f9a45)}
.pvz-entry.narrow{padding:6px 0;justify-content:center}
.pvz-entry.narrow .e{width:24px;height:24px}
`;
    function ensureCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsh-pvz-css')) return;
      const el = document.createElement('style');
      el.id = 'dsh-pvz-css';
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // 组件可能被渲染进 shadow root：样式必须注入到它自己的 root，否则完全不生效
    function useCss(ref) {
      React.useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const root = (node.getRootNode && node.getRootNode()) || document;
        if (root.querySelector && root.querySelector('#dsh-pvz-css')) return;
        const host = root.head || root;
        if (!host || !host.appendChild) return;
        const el = document.createElement('style');
        el.id = 'dsh-pvz-css';
        el.textContent = CSS;
        host.appendChild(el);
      }, []);
    }

    const cls = (...xs) => xs.filter(Boolean).join(' ');

    function GameStage(props) {
      if (props.alive === false) {
        return h('div', { className: 'pvz-frame pvz-off' }, '这一局已经关了，点「开局」重新开一局');
      }
      return h('iframe', { src: '/dsh-pvz/game/index.html?v=4', className: 'pvz-frame', allow: 'autoplay; fullscreen' });
    }

    function Stat(props) {
      return h('div', { className: 'pvz-stat' }, h('b', null, props.value), h('span', null, props.label));
    }

    function WaveBar(props) {
      const { wave = 0, max = 1 } = props
      const total = Math.max(1, max || 1)
      const cur = Math.max(0, Math.min(total, wave < 0 ? 0 : wave + 1))
      const pct = Math.round((cur / total) * 100)
      return h('div', { className: 'pvz-wave' },
        h('div', { className: 'pvz-wave-track' }, h('div', { className: 'pvz-wave-fill', style: { width: pct + '%' } })),
        h('span', { className: 'pvz-wave-txt' }, `${cur}/${total}`))
    }

    function AiPanel() {
      const { state: g, meta } = useGame();
      const s = g || {};
      const m = meta || {};
      const ai = m.autoplay || {};
      const [interval, setIntervalSec] = React.useState(ai.intervalSec || 8);
      const [map, setMap] = React.useState(false);
      React.useEffect(() => {
        if (ai.intervalSec) setIntervalSec(ai.intervalSec);
      }, [ai.intervalSec]);
      const running = !!g && !!s.game;
      const status = !g ? '连接中' : !s.game ? '待开局' : s.result === 'win' ? '通关' : s.paused ? '暂停' : '进行中';
      const done = (m.campaign && m.campaign.done) || 0;
      const total = (m.campaign && m.campaign.total) || 50;

      return h(
        'aside',
        { className: 'pvz-side' },
        h(
          'div',
          { className: 'pvz-side-hd' },
          h('div', { className: 'pvz-av' }, '🌻'),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { className: 'pvz-nm' }, s.endless ? '无尽模式' : (s.game ? (s.level || '冒险模式') : '植物大战僵尸')),
            h('div', { className: 'pvz-sub' }, `${status} · 冒险 ${done}/${total}`),
          ),
        ),

        h(
          'div',
          { className: 'pvz-tabs' },
          h('button', { className: cls('pvz-tab', !s.endless && 'on'), onClick: () => ctl('start') }, '冒险'),
          h('button', { className: cls('pvz-tab', s.endless && 'on'), onClick: () => ctl('endless') }, '无尽'),
        ),

        h(
          'div',
          { className: 'pvz-row' },
          h('button', { className: 'pvz-btn primary', onClick: async () => { if (!alive) { pendingStart = true; patch({ open: true, alive: true }); return } await ctl('start') } }, '开局'),
          h('button', { className: 'pvz-btn', onClick: () => ctl(s.paused ? 'resume' : 'pause') }, s.paused ? '继续' : '暂停'),
          h('button', { className: 'pvz-btn', onClick: () => ctl('restart') }, '重来'),
        ),

        h(
          'div',
          { className: 'pvz-row', style: { marginTop: 8 } },
          h('button', {
            className: cls('pvz-btn', ai.on && 'on'),
            style: { flex: 1 },
            onClick: () => ctl('autoplay', { on: !ai.on, intervalSec: interval }),
          }, ai.on ? '■ 停止代打' : '🤖 AI 代打'),
          h('span', { className: 'pvz-sec' }, interval + 's'),
        ),
        ai.on
          ? h('div', { className: 'pvz-row', style: { marginTop: 6 } },
              h('input', {
                type: 'range', min: 4, max: 20, step: 1, value: interval,
                className: 'pvz-range', style: { flex: 1 },
                onChange: (e) => setIntervalSec(Number(e.target.value)),
                onMouseUp: () => ctl('autoplay', { on: true, intervalSec: interval }),
              }))
          : null,

        h(
          'button',
          { className: cls('pvz-btn', 'wide'), style: { margin: '10px 14px 0' }, onClick: () => setMap((v) => !v) },
          map ? '选关 ▴' : '选关 ▾',
        ),
        map
          ? h(
              'div',
              { className: 'pvz-map' },
              Array.from({ length: 50 }, (_, i) => {
                const isDone = i < done;
                const cur = m.campaign && i === m.campaign.idx;
                const locked = i > done;
                return h('button', {
                  key: i,
                  disabled: locked,
                  className: cls('pvz-cell', isDone && 'done', cur && 'cur'),
                  onClick: () => { if (!alive) { pendingStart = true; patch({ open: true, alive: true }); return } ctl('start', { level: `i:${i + 1}` }); setMap(false) },
                }, `${Math.floor(i / 10) + 1}-${(i % 10) + 1}`);
              }),
            )
          : null,

        h('div', { className: 'pvz-h' }, '动态'),
        h(
          'div',
          { className: 'pvz-log' },
          (m.lastLog || []).length
            ? (m.lastLog || []).map((line, i) => {
                const mm = /^(\S+)\s(.*)\|(\w+)$/.exec(line);
                return h('div', { key: i, className: cls('pvz-line', 'who-' + (mm ? mm[3] : 'sys')) }, mm ? mm[2] : line);
              })
            : h('em', null, '还没有动态'),
        ),
      );
    }

    function GameWindow() {
      const w = useWin();
      const boxRef = React.useRef(null);
      useCss(boxRef);
      const live = React.useRef(null);
      const [busy, setBusy] = React.useState(null);

      const hidden = !w.open;
      const alive = w.alive !== false;

      const width = Math.max(620, Math.min(w.w, window.innerWidth - 40));
      const height = Math.max(400, Math.min(w.h, window.innerHeight - 40));
      const left = w.x == null ? Math.max(24, window.innerWidth - width - 60) : Math.max(0, Math.min(w.x, window.innerWidth - 140));
      const top = w.y == null ? Math.max(24, window.innerHeight - height - 80) : Math.max(0, Math.min(w.y, window.innerHeight - 60));

      // 拖动/缩放过程中直接改 DOM，不走 React 重渲染，避免每像素一次 reflow + localStorage 写入
      const MIN_W = 520;
      const MIN_H = 340;

      const begin = (kind, e, dir) => {
        live.current = { kind, dir, x0: e.clientX, y0: e.clientY, x: left, y: top, w: width, h: height, nx: left, ny: top, nw: width, nh: height };
        setBusy(kind);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
        e.stopPropagation();
        e.preventDefault();
      };

      const move = (e) => {
        const d = live.current;
        if (!d || !boxRef.current) return;
        const el = boxRef.current;
        const dx = e.clientX - d.x0;
        const dy = e.clientY - d.y0;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (d.kind === 'drag') {
          d.nx = Math.max(-d.w + 160, Math.min(d.x + dx, vw - 160));
          d.ny = Math.max(0, Math.min(d.y + dy, vh - 46));
        } else {
          const dir = d.dir || 'se';
          let nx = d.x, ny = d.y, nw = d.w, nh = d.h;
          if (dir.includes('e')) nw = Math.min(Math.max(MIN_W, d.w + dx), vw - d.x - 4);
          if (dir.includes('s')) nh = Math.min(Math.max(MIN_H, d.h + dy), vh - d.y - 4);
          if (dir.includes('w')) {
            nw = Math.max(MIN_W, d.w - dx);
            nx = Math.max(0, Math.min(d.x + (d.w - nw), vw - MIN_W));
            nw = d.x + d.w - nx;
          }
          if (dir.includes('n')) {
            nh = Math.max(MIN_H, d.h - dy);
            ny = Math.max(0, Math.min(d.y + (d.h - nh), vh - MIN_H));
            nh = d.y + d.h - ny;
          }
          d.nx = nx; d.ny = ny; d.nw = nw; d.nh = nh;
        }
        el.style.left = d.nx + 'px';
        el.style.top = d.ny + 'px';
        el.style.width = d.nw + 'px';
        el.style.height = d.nh + 'px';
      };

      const end = () => {
        const d = live.current;
        live.current = null;
        setBusy(null);
        if (!d) return;
        patch({ x: d.nx, y: d.ny, w: d.nw, h: d.nh });
      };

      const fullscreen = () => {
        patch({ open: true, x: 12, y: 12, w: window.innerWidth - 24, h: window.innerHeight - 24 });
        const el = boxRef.current;
        if (!el) return;
        el.style.transition = 'all .22s cubic-bezier(.2,.9,.25,1)';
        setTimeout(() => { el.style.transition = ''; }, 240);
      };

      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            ref: boxRef,
            className: 'pvz-win',
            style: {
              // 内联兜底：即使外部样式表没注入成功，窗口也能正常显示与缩放
              position: 'fixed',
              zIndex: 2147483000,
              left,
              top,
              width,
              height,
              display: hidden ? 'none' : 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRadius: 16,
              background: 'linear-gradient(165deg,#1c2418 0%,#12180f 38%,#0a0e08 100%)',
              color: '#e9f0e4',
              boxShadow: '0 48px 140px rgba(0,0,0,.72),0 0 0 1px rgba(255,255,255,.13)',
              transition: 'none',
            },
            onPointerMove: move,
            onPointerUp: end,
            onPointerCancel: end,
          },
          h(
            'div',
            {
              className: cls('pvz-bar', busy === 'drag' && 'dragging'),
              onPointerDown: (e) => {
                if (e.target.closest('button')) return;
                begin('drag', e);
              },
            },
            h(
              'div',
              { className: 'pvz-dots' },
              h('button', { className: 'pvz-dot c', title: '关闭（结束这一局）', onClick: async () => { try { await ctl('close') } catch (e) {} patch({ open: false, alive: false, min: false }) } }),
              h('button', { className: 'pvz-dot m', title: '收起（后台继续跑）', onClick: () => patch({ open: false, min: true }) }),
              h('button', { className: 'pvz-dot f', title: '铺满', onClick: fullscreen }),
            ),
            h('div', { className: 'pvz-t' }, '植物大战僵尸', h('small', null, 'DSH 版')),
            h('div', { className: 'pvz-sp' }),
          ),
          h(
            'div',
            { className: 'pvz-main', style: busy ? { pointerEvents: 'none' } : null },
            h('div', { className: 'pvz-stage' }, h(GameStage, { alive })),
            h(AiPanel),
          ),
          // 八向缩放把手：四条边 + 四个角
          ...[
            ['n', { top: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }],
            ['s', { bottom: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }],
            ['w', { left: 0, top: 14, bottom: 14, width: 6, cursor: 'ew-resize' }],
            ['e', { right: 0, top: 14, bottom: 14, width: 6, cursor: 'ew-resize' }],
            ['nw', { top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize' }],
            ['ne', { top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize' }],
            ['sw', { bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' }],
            ['se', { bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize' }],
          ].map(([dir, st]) =>
            h('div', {
              key: dir,
              className: 'pvz-grab',
              style: { position: 'absolute', zIndex: 6, touchAction: 'none', ...st },
              onPointerDown: (e) => begin('size', e, dir),
            }),
          ),
          h('div', {
            className: 'pvz-grab',
            title: '拖动改变大小',
            style: {
              position: 'absolute', right: 0, bottom: 0, width: 22, height: 22,
              cursor: 'nwse-resize', zIndex: 7, pointerEvents: 'none',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
              padding: 3, color: 'rgba(210,235,190,.55)', fontSize: 13, lineHeight: 1,
            },
          }, '◢'),
        ),
      );
    }

    // ---------- 左侧栏入口 ----------
    function FooterEntry(props) {
      ensureCss();
      const wide = props && props.wide !== false;
      return h(
        'button',
        { className: cls('pvz-entry', !wide && 'narrow'), onClick: () => patch({ open: true, alive: true, min: false }), title: '植物大战僵尸' },
        h('span', { className: 'e' }, '🌻'),
        wide ? h('span', null, '植物大战僵尸') : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureCss();
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register({ name: 'shell.overlay', id: APP_ID, order: 40 }, GameWindow),
            ),
          'dsh-pvz: floating window',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.footer.action', () =>
              ctx.slots.register({ name: 'sidebar.footer.action', id: APP_ID + '-entry' }, FooterEntry),
            ),
          'dsh-pvz: sidebar entry',
        );
      },
    };
  },
});
