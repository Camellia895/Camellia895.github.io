// ==UserScript==
// @name         Font Sniffer & Converter / 字体嗅探与转换
// @name:zh-CN   字体嗅探与转换
// @namespace    https://github.com/font-sniffer/font-sniffer
// @version      1.0.0
// @description  自动捕获网页加载的字体文件，支持页面内预览、下载原始字体，并将 WOFF / WOFF2 转换为可用的 TTF / OTF。提供可拖动的悬浮面板。
// @description:en  Auto-capture web fonts on any page: preview, download originals, and convert WOFF/WOFF2 to usable TTF/OTF. Floating draggable panel.
// @author       you
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 常量与工具
   * ------------------------------------------------------------------ */
  const FONT_EXT = ['woff2', 'woff', 'ttf', 'otf', 'eot'];
  const SAMPLE_DEFAULT = 'Whereof one cannot speak  中文示例字体  0123456789';
  const PAKO_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
  // woff2 解码模块（运行时按需加载；在严格 CSP 下可能失败，失败时仅影响 woff2 转换）
  const WOFF2_URL = 'https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/+esm';

  const store = new Map();           // id -> font object
  let seq = 0;
  let panelOpen = false;
  const listeners = [];
  const onChange = (fn) => listeners.push(fn);
  const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) {} });

  const log = (...a) => console.debug('[FontSniffer]', ...a);

  function extOf(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function baseName(font) {
    try {
      const u = new URL(font.url, location.href);
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      const name = seg.replace(/\.[a-z0-9]+$/i, '');
      if (name) return name;
    } catch (e) {}
    return (font.family || 'font').replace(/[^\w.\-]+/g, '_');
  }

  function looksLikeFont(url) {
    if (!url) return false;
    if (url.startsWith('data:')) return /^data:(?:application\/(?:x-)?font|font)[\w.\-]*[;,]/i.test(url);
    return FONT_EXT.includes(extOf(url));
  }

  /* ------------------------------------------------------------------ *
   * 1. 字节获取（跨域：GM_xmlhttpRequest；data: 直接解码）
   * ------------------------------------------------------------------ */
  function decodeDataUri(uri) {
    const comma = uri.indexOf(',');
    const meta = uri.slice(5, comma);
    const data = uri.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const bin = atob(data.trim());
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    return new TextEncoder().encode(decodeURIComponent(data));
  }

  function gmFetchBytes(url) {
    return new Promise((resolve, reject) => {
      if (url.startsWith('data:')) {
        try { resolve(decodeDataUri(url)); } catch (e) { reject(e); }
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        anonymous: false,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.response) {
            resolve(new Uint8Array(r.response));
          } else {
            reject(new Error('HTTP ' + r.status));
          }
        },
        onerror: () => reject(new Error('网络错误 / network error')),
        ontimeout: () => reject(new Error('超时 / timeout')),
      });
    });
  }

  function gmFetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: (r) => (r.status >= 200 && r.status < 300)
          ? resolve(r.responseText)
          : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('net')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. 动态加载依赖（运行时加载，CDN 不可用时不影响主功能）
   * ------------------------------------------------------------------ */
  let _pako = null, _pakoP = null;
  async function getPako() {
    if (_pako) return _pako;
    if (!_pakoP) {
      _pakoP = (async () => {
        const txt = await gmFetchText(PAKO_URL);
        const mod = { exports: {} };
        const fn = new Function('module', 'exports',
          txt + '\n;return (typeof pako!=="undefined")?pako:(module.exports||exports);');
        _pako = fn(mod, mod.exports);
        return _pako;
      })();
    }
    return _pakoP;
  }

  let _woff2P = null;
  async function getWoff2() {
    if (!_woff2P) {
      _woff2P = (async () => {
        // 动态 import：需要浏览器/管理器与页面 CSP 允许
        const mod = await import(/* @vite-ignore */ WOFF2_URL);
        const fn = mod.decompress || (mod.default && mod.default.decompress);
        if (typeof fn !== 'function') throw new Error('woff2 解码接口不可用');
        return fn;
      })();
    }
    return _woff2P;
  }

  /* ------------------------------------------------------------------ *
   * 3. 格式识别与转换
   * ------------------------------------------------------------------ */
  function magic(u8) {
    if (!u8 || u8.length < 4) return 'unknown';
    const s = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (s === 'wOFF') return 'woff';
    if (s === 'wOF2') return 'woff2';
    if (s === 'OTTO') return 'sfnt';      // CFF / OpenType
    if (s === 'true' || s === 'typ1' || s === 'ttcf') return 'sfnt';
    if (u8[0] === 0x00 && u8[1] === 0x01 && u8[2] === 0x00 && u8[3] === 0x00) return 'sfnt';
    return 'unknown';
  }

  function sfntExt(u8) {
    const s = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    return s === 'OTTO' ? 'otf' : 'ttf';
  }

  function tag4(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }

  // WOFF -> SFNT（纯 JS：解 zlib + 重建表目录），可靠
  async function woffToSfnt(u8) {
    const pako = await getPako();
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const flavor = dv.getUint32(4);
    const numTables = dv.getUint16(12);

    const entries = [];
    let p = 44;
    for (let i = 0; i < numTables; i++) {
      const tag = tag4(dv, p);
      const offset = dv.getUint32(p + 4);
      const compLength = dv.getUint32(p + 8);
      const origLength = dv.getUint32(p + 12);
      const origChecksum = dv.getUint32(p + 16);
      let data = u8.subarray(offset, offset + compLength);
      if (compLength < origLength) data = pako.inflate(data);
      if (data.length !== origLength) {
        const fixed = new Uint8Array(origLength);
        fixed.set(data.subarray(0, origLength));
        data = fixed;
      }
      entries.push({ tag, origChecksum, data });
      p += 20;
    }
    // OpenType 要求表目录按 tag 升序
    entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

    let maxPow = 1, exp = 0;
    while (maxPow * 2 <= numTables) { maxPow *= 2; exp++; }
    const searchRange = maxPow * 16;
    const rangeShift = numTables * 16 - searchRange;

    const headerSize = 12 + 16 * numTables;
    let offset = headerSize;
    for (const e of entries) { e.offset = offset; offset += e.data.length; offset = (offset + 3) & ~3; }

    const out = new Uint8Array(offset);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, flavor);
    odv.setUint16(4, numTables);
    odv.setUint16(6, searchRange);
    odv.setUint16(8, exp);
    odv.setUint16(10, rangeShift);
    let rp = 12;
    for (const e of entries) {
      out[rp] = e.tag.charCodeAt(0); out[rp + 1] = e.tag.charCodeAt(1);
      out[rp + 2] = e.tag.charCodeAt(2); out[rp + 3] = e.tag.charCodeAt(3);
      odv.setUint32(rp + 4, e.origChecksum >>> 0);
      odv.setUint32(rp + 8, e.offset);
      odv.setUint32(rp + 12, e.data.length);
      rp += 16;
      out.set(e.data, e.offset);
    }
    return out;
  }

  async function woff2ToSfnt(u8) {
    const decompress = await getWoff2();
    const out = await decompress(u8);
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  // 统一转换入口 -> { bytes, ext }
  async function toSfnt(u8) {
    const m = magic(u8);
    if (m === 'sfnt') return { bytes: u8, ext: sfntExt(u8) };
    if (m === 'woff') { const o = await woffToSfnt(u8); return { bytes: o, ext: sfntExt(o) }; }
    if (m === 'woff2') { const o = await woff2ToSfnt(u8); return { bytes: o, ext: sfntExt(o) }; }
    throw new Error('无法识别或暂不支持的字体格式: ' + m);
  }

  /* ------------------------------------------------------------------ *
   * 4. 下载
   * ------------------------------------------------------------------ */
  function downloadBytes(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime || 'font/sfnt' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ------------------------------------------------------------------ *
   * 5. 捕获：PerformanceObserver + 样式表扫描 + document.fonts
   * ------------------------------------------------------------------ */
  function addCandidate(url, family) {
    if (!looksLikeFont(url)) return;
    let abs = url;
    try { abs = new URL(url, location.href).href; } catch (e) {}
    if (store.has(abs)) {
      const f = store.get(abs);
      if (family && (!f.family || f.family === f.fallbackName)) f.family = family;
      return;
    }
    const id = 'f' + (++seq);
    store.set(abs, {
      id,
      url: abs,
      family: family || '',
      fallbackName: family || '',
      ext: extOf(abs) || (abs.startsWith('data:') ? (abs.match(/font[\/-]([a-z0-9]+)/i) || [, ''])[1] : ''),
      format: '',
      sizeBytes: null,
      bytes: null,
      status: 'idle',       // idle | loading | ready | error
      error: '',
      previewFamily: 'FS_' + id,
      faceAdded: false,
    });
    emit();
  }

  function extractUrls(src) {
    const out = [];
    if (!src) return out;
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m;
    while ((m = re.exec(src))) out.push(m[2].trim());
    return out;
  }

  function scanStyleSheets() {
    for (const sheet of Array.from(document.styleSheets || [])) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // 跨域样式表无法读取 -> 由 Performance 兜底
      if (!rules) continue;
      walkRules(rules, sheet.href || document.baseURI);
    }
  }

  function walkRules(rules, base) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          const fam = (rule.style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim();
          const src = rule.style.getPropertyValue('src');
          extractUrls(src).forEach((u) => {
            let abs = u;
            try { abs = new URL(u, base).href; } catch (e) {}
            addCandidate(abs, fam);
          });
        } else if (rule.cssRules) {
          walkRules(rule.cssRules, base);
        }
      } catch (e) {}
    }
  }

  function scanDocumentFonts() {
    try {
      document.fonts.forEach((ff) => {
        // FontFace 不暴露源字节，仅用于补全可能的 family 名（信息有限，故跳过精确匹配）
        void ff;
      });
    } catch (e) {}
  }

  function startCapture() {
    // Performance：buffered 捕获已加载资源，并持续监听新资源
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) addCandidate(e.name);
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (e) {
      try {
        (performance.getEntriesByType('resource') || []).forEach((e) => addCandidate(e.name));
      } catch (_) {}
    }

    const doScan = () => { try { scanStyleSheets(); scanDocumentFonts(); } catch (e) {} };
    doScan();
    [300, 900, 2000, 4000].forEach((t) => setTimeout(doScan, t));

    // 监听 DOM 变化，捕获后注入的 <style>/<link>
    try {
      const mo = new MutationObserver((muts) => {
        for (const mt of muts) {
          for (const n of mt.addedNodes) {
            if (n.nodeType === 1 && (n.tagName === 'STYLE' || n.tagName === 'LINK')) {
              setTimeout(doScan, 50);
              return;
            }
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 6. 加载字节 + 预览
   * ------------------------------------------------------------------ */
  async function ensureBytes(font) {
    if (font.bytes) return font.bytes;
    if (font.status === 'loading') return null;
    font.status = 'loading'; emit();
    try {
      const u8 = await gmFetchBytes(font.url);
      font.bytes = u8;
      font.sizeBytes = u8.length;
      const m = magic(u8);
      if (m !== 'unknown') font.format = m;
      font.status = 'ready';
    } catch (e) {
      font.status = 'error';
      font.error = String(e.message || e);
    }
    emit();
    return font.bytes;
  }

  function applyPreview(font, sampleEl) {
    if (!font.bytes || !sampleEl) return;
    try {
      if (!font.faceAdded) {
        // FontFace 接受 BufferSource，原始字节直接交给浏览器解析（ttf/otf/woff/woff2 均原生支持）
        const ff = new FontFace(font.previewFamily, font.bytes);
        ff.load().then((loaded) => {
          document.fonts.add(loaded);
          font.faceAdded = true;
          sampleEl.style.fontFamily = `"${font.previewFamily}", sans-serif`;
        }).catch((e) => {
          sampleEl.textContent = '（无法预览：' + (e.message || e) + '）';
        });
      } else {
        sampleEl.style.fontFamily = `"${font.previewFamily}", sans-serif`;
      }
    } catch (e) {
      sampleEl.textContent = '（无法预览：' + (e.message || e) + '）';
    }
  }

  async function loadAllForPreview() {
    const items = Array.from(store.values()).filter((f) => !f.bytes && f.status !== 'loading' && !f.url.startsWith('data:eot'));
    // data:eot 极少见；其余正常加载
    let idx = 0;
    const concurrency = 3;
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => {
        while (idx < items.length) {
          const cur = items[idx++];
          await ensureBytes(cur);
        }
      })());
    }
    await Promise.all(workers);
  }

  /* ------------------------------------------------------------------ *
   * 7. UI（Shadow DOM 隔离，样式不受宿主页面影响）
   * ------------------------------------------------------------------ */
  let root, ui = {};

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
    .fab {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
      width: 48px; height: 48px; border-radius: 50%; cursor: pointer;
      background: #2b2f3a; color: #fff; border: none; box-shadow: 0 4px 16px rgba(0,0,0,.3);
      font-size: 22px; display: flex; align-items: center; justify-content: center;
      transition: transform .15s;
    }
    .fab:hover { transform: scale(1.07); }
    .fab .badge {
      position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
      padding: 0 4px; border-radius: 9px; background: #e5484d; color: #fff;
      font-size: 11px; line-height: 18px; text-align: center;
    }
    .panel {
      position: fixed; right: 18px; bottom: 78px; z-index: 2147483646;
      width: 420px; max-width: calc(100vw - 24px); max-height: 78vh;
      background: #1f2330; color: #e8e9ee; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.45); display: none; flex-direction: column;
      overflow: hidden; border: 1px solid #333a4d;
    }
    .panel.open { display: flex; }
    .hd {
      display: flex; align-items: center; gap: 8px; padding: 12px 14px;
      background: #262b3a; cursor: move; user-select: none;
    }
    .hd h1 { font-size: 14px; margin: 0; font-weight: 600; flex: 1; }
    .hd .cnt { font-size: 12px; color: #9aa0b4; }
    .icon-btn {
      background: transparent; border: none; color: #c8cbe0; cursor: pointer;
      font-size: 14px; padding: 4px 7px; border-radius: 6px;
    }
    .icon-btn:hover { background: #333a4d; }
    .toolbar { padding: 10px 14px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid #333a4d; flex-wrap: wrap; }
    .toolbar input[type=text] {
      flex: 1; min-width: 140px; background: #161922; color: #e8e9ee;
      border: 1px solid #3a4156; border-radius: 8px; padding: 6px 9px; font-size: 13px;
    }
    .toolbar input[type=range] { width: 90px; }
    .toolbar .sz { font-size: 12px; color: #9aa0b4; width: 34px; text-align: right; }
    .btn {
      background: #3a4156; color: #e8e9ee; border: none; border-radius: 8px;
      padding: 6px 10px; font-size: 12px; cursor: pointer;
    }
    .btn:hover { background: #49506a; }
    .btn.primary { background: #4763ff; }
    .btn.primary:hover { background: #5a73ff; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .list { overflow-y: auto; padding: 8px; flex: 1; }
    .empty { color: #8b91a7; text-align: center; padding: 30px 12px; font-size: 13px; }
    .card {
      background: #262b3a; border: 1px solid #333a4d; border-radius: 10px;
      padding: 10px 11px; margin-bottom: 8px;
    }
    .card .top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .card .name { font-size: 13px; font-weight: 600; flex: 1; word-break: break-all; }
    .badge2 {
      font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 5px;
      background: #3a4156; color: #b9c0db; letter-spacing: .5px;
    }
    .badge2.woff2 { background: #3a2f5c; color: #cdb6ff; }
    .badge2.woff { background: #2f4a5c; color: #b6e3ff; }
    .badge2.ttf, .badge2.otf, .badge2.sfnt { background: #2f5c3a; color: #b6ffcb; }
    .meta { font-size: 11px; color: #8b91a7; margin-bottom: 6px; word-break: break-all; }
    .sample {
      background: #fff; color: #111; border-radius: 7px; padding: 10px 11px;
      font-size: 22px; line-height: 1.35; min-height: 30px; margin-bottom: 8px;
      overflow: hidden; word-break: break-word;
    }
    .sample.pending { background: #161922; color: #6b7186; font-size: 13px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .status { font-size: 11px; color: #e5a04d; }
    .status.err { color: #ff7b7e; }
    .foot { padding: 8px 14px; font-size: 11px; color: #8b91a7; border-top: 1px solid #333a4d; }
    a.link { color: #7d93ff; cursor: pointer; text-decoration: underline; }
  `;

  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = '__font_sniffer_host__';
    host.style.cssText = 'all:initial; position:fixed; z-index:2147483647;';
    (document.body || document.documentElement).appendChild(host);
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.title = '字体嗅探与转换';
    fab.innerHTML = '𝐅<span class="badge" style="display:none">0</span>';
    fab.addEventListener('click', togglePanel);
    root.appendChild(fab);
    ui.fab = fab;
    ui.badge = fab.querySelector('.badge');

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="hd">
        <h1>字体嗅探 <span class="cnt"></span></h1>
        <button class="icon-btn" data-act="refresh" title="重新扫描">⟳</button>
        <button class="icon-btn" data-act="close" title="关闭">✕</button>
      </div>
      <div class="toolbar">
        <input type="text" class="sample-input" placeholder="预览文字…" />
        <input type="range" min="12" max="64" value="22" class="size-range" />
        <span class="sz">22</span>
        <button class="btn" data-act="dlall">下载全部原始</button>
      </div>
      <div class="list"></div>
      <div class="foot"></div>
    `;
    root.appendChild(panel);
    ui.panel = panel;
    ui.cnt = panel.querySelector('.cnt');
    ui.list = panel.querySelector('.list');
    ui.foot = panel.querySelector('.foot');
    ui.sampleInput = panel.querySelector('.sample-input');
    ui.sizeRange = panel.querySelector('.size-range');
    ui.szLabel = panel.querySelector('.sz');

    ui.sampleInput.value = SAMPLE_DEFAULT;
    ui.sampleInput.addEventListener('input', updateSamplesText);
    ui.sizeRange.addEventListener('input', () => {
      ui.szLabel.textContent = ui.sizeRange.value;
      root.querySelectorAll('.sample').forEach((el) => { el.style.fontSize = ui.sizeRange.value + 'px'; });
    });

    panel.querySelector('[data-act=close]').addEventListener('click', togglePanel);
    panel.querySelector('[data-act=refresh]').addEventListener('click', () => { scanStyleSheets(); render(); loadAllForPreview(); });
    panel.querySelector('[data-act=dlall]').addEventListener('click', downloadAllOriginals);

    makeDraggable(panel, panel.querySelector('.hd'));
    onChange(() => { updateBadge(); if (panelOpen) render(); });
    updateBadge();
  }

  function updateSamplesText() {
    const txt = ui.sampleInput.value || ' ';
    root.querySelectorAll('.sample:not(.pending)').forEach((el) => { el.textContent = txt; });
  }

  function updateBadge() {
    const n = store.size;
    ui.badge.textContent = n;
    ui.badge.style.display = n ? 'block' : 'none';
    if (ui.cnt) ui.cnt.textContent = '(' + n + ')';
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    ui.panel.classList.toggle('open', panelOpen);
    if (panelOpen) { scanStyleSheets(); render(); loadAllForPreview(); }
  }

  function render() {
    const fonts = Array.from(store.values());
    ui.list.innerHTML = '';
    if (!fonts.length) {
      ui.list.innerHTML = '<div class="empty">尚未捕获到字体。<br>试着刷新页面，或点击右上角 ⟳ 重新扫描。</div>';
      ui.foot.textContent = '';
      return;
    }
    const txt = ui.sampleInput.value || ' ';
    const fontSize = ui.sizeRange.value + 'px';

    for (const f of fonts) {
      const fmt = (f.format || f.ext || '?').toLowerCase();
      const card = document.createElement('div');
      card.className = 'card';

      const convertible = ['woff', 'woff2', 'sfnt', 'ttf', 'otf'].includes(fmt);
      const isWoff2 = fmt === 'woff2';

      card.innerHTML = `
        <div class="top">
          <span class="name"></span>
          <span class="badge2 ${fmt}">${fmt}</span>
        </div>
        <div class="meta"></div>
        <div class="sample pending">加载中…</div>
        <div class="actions">
          <button class="btn" data-a="dl">下载原始</button>
          <button class="btn primary" data-a="cv" ${convertible ? '' : 'disabled'}>转 TTF/OTF</button>
          <button class="btn" data-a="url">复制链接</button>
          <span class="status"></span>
        </div>
      `;
      const nameEl = card.querySelector('.name');
      nameEl.textContent = baseName(f) + (f.family && f.family !== baseName(f) ? '  ·  ' + f.family : '');
      card.querySelector('.meta').textContent = fmtSize(f.sizeBytes) + '  ·  ' + (f.url.startsWith('data:') ? 'data: URI（内嵌）' : f.url);

      const sample = card.querySelector('.sample');
      const statusEl = card.querySelector('.status');

      if (f.status === 'ready' && f.bytes) {
        sample.classList.remove('pending');
        sample.textContent = txt;
        sample.style.fontSize = fontSize;
        applyPreview(f, sample);
      } else if (f.status === 'error') {
        sample.textContent = '（加载失败：' + f.error + '）';
        statusEl.textContent = '无法获取字节';
        statusEl.classList.add('err');
      } else if (f.status === 'loading') {
        sample.textContent = '加载中…';
      } else {
        sample.textContent = '待加载…';
      }

      card.querySelector('[data-a=dl]').addEventListener('click', async () => {
        statusEl.classList.remove('err'); statusEl.textContent = '准备下载…';
        const b = await ensureBytes(f);
        if (!b) { statusEl.textContent = '获取失败'; statusEl.classList.add('err'); return; }
        downloadBytes(b, baseName(f) + '.' + (f.format || f.ext || 'bin'), 'font/' + (f.format || f.ext || 'octet-stream'));
        statusEl.textContent = '已下载原始文件';
      });

      card.querySelector('[data-a=cv]').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        statusEl.classList.remove('err'); statusEl.textContent = '转换中…';
        try {
          const b = await ensureBytes(f);
          if (!b) throw new Error('无法获取字节');
          const { bytes, ext } = await toSfnt(b);
          downloadBytes(bytes, baseName(f) + '.' + ext, 'font/' + ext);
          statusEl.textContent = '已转换并下载 .' + ext;
        } catch (e) {
          statusEl.classList.add('err');
          statusEl.textContent = (isWoff2 ? 'WOFF2 转换失败（可能受 CDN/CSP 限制）：' : '转换失败：') + (e.message || e);
        } finally {
          btn.disabled = false;
        }
      });

      card.querySelector('[data-a=url]').addEventListener('click', () => {
        navigator.clipboard && navigator.clipboard.writeText(f.url).then(
          () => { statusEl.textContent = '链接已复制'; },
          () => { statusEl.textContent = f.url; }
        );
      });

      ui.list.appendChild(card);
    }

    ui.foot.innerHTML = 'WOFF / TTF / OTF 转换为本地处理，稳定可用；WOFF2 转换需运行时加载解码模块，可能因页面 CSP 受限。预览与原始下载始终可用。';
  }

  async function downloadAllOriginals() {
    const fonts = Array.from(store.values());
    for (const f of fonts) {
      const b = await ensureBytes(f);
      if (b) {
        downloadBytes(b, baseName(f) + '.' + (f.format || f.ext || 'bin'), 'font/' + (f.format || f.ext || 'octet-stream'));
        await new Promise((r) => setTimeout(r, 350)); // 避免浏览器拦截批量下载
      }
    }
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.icon-btn')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  /* ------------------------------------------------------------------ *
   * 8. 启动
   * ------------------------------------------------------------------ */
  function init() {
    startCapture();
    buildUI();
    try {
      GM_registerMenuCommand('打开 / 关闭 字体面板', togglePanel);
      GM_registerMenuCommand('重新扫描字体', () => { scanStyleSheets(); render(); });
    } catch (e) {}
  }

  if (document.body) {
    init();
  } else {
    // run-at document-start：先启动捕获，DOM 就绪后再建 UI
    startCapture();
    document.addEventListener('DOMContentLoaded', () => { buildUI(); try {
      GM_registerMenuCommand('打开 / 关闭 字体面板', togglePanel);
      GM_registerMenuCommand('重新扫描字体', () => { scanStyleSheets(); render(); });
    } catch (e) {} }, { once: true });
  }
})();
