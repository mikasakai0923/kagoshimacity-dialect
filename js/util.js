/* かごしま ことばさんぽ — 小さな道具 */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};
  KS.VERSION = '0.3.1';

  /* ---------- 画面の部品を作る ---------- */

  // h('div', {class:'x', onclick:fn}, 子ども…)  文字は必ず「文字として」入れる（HTMLとしては解釈しない）
  KS.h = function (tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'svg') el.innerHTML = v;                // サイト内に用意した絵（art.js）だけに使う
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') { for (var s in v) el.style[s] = v[s]; }
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  };
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { for (var i = 0; i < child.length; i++) append(el, child[i]); return; }
    if (typeof child === 'string' || typeof child === 'number') { el.appendChild(document.createTextNode(String(child))); return; }
    el.appendChild(child);
  }
  KS.append = append;

  /* ---------- ふりがな：「鯖《さば》」→ ルビ ---------- */

  var RUBY_RE = /([々〇一-鿿豈-﫿]+)《([^》]*)》/g;
  KS.ruby = function (text) {
    var frag = document.createDocumentFragment();
    var s = String(text == null ? '' : text), last = 0, m;
    RUBY_RE.lastIndex = 0;
    while ((m = RUBY_RE.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      var rb = document.createElement('ruby');
      rb.appendChild(document.createTextNode(m[1]));
      var rt = document.createElement('rt');
      rt.textContent = m[2];
      rb.appendChild(rt);
      frag.appendChild(rb);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  };
  KS.plain = function (text) { return String(text == null ? '' : text).replace(/《[^》]*》/g, ''); };

  /* ---------- 文字 ---------- */

  // 参加者ナンバーとパスワード用：全角の英数字を半角にそろえる
  KS.norm = function (v) {
    var s = String(v == null ? '' : v);
    if (s.normalize) s = s.normalize('NFKC');
    return s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  };
  KS.normId = function (v) { return KS.norm(v).replace(/\s+/g, '').toUpperCase(); };

  // 回答用：書かれたとおりに残す（「か゜」のような書き方や、全角・半角を勝手に変えない）。
  // 取りのぞくのは、前後の空白と、目に見えない制御文字だけ。改行は残す。
  KS.clean = function (v) {
    return String(v == null ? '' : v)
      .replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  };

  // ひらがな・カタカナ（半角も）・濁点や半濁点・のばす音・句読点・空白だけなら true
  var KANA_RE = new RegExp('^[' +
    '\\u3041-\\u309F' +          // ひらがな（濁点・半濁点の記号をふくむ）
    '\\u30A1-\\u30FF\\u31F0-\\u31FF' +   // カタカナ・のばす音・中点
    '\\uFF65-\\uFF9F' +          // 半角カタカナ
    '\\u3000-\\u3002\\uFF0C\\uFF0E\\uFF01\\uFF1F!?,.\\u2026' +   // 空白・句読点・！？…
    '\\u301C\\uFF5E~\\u300C\\u300D\\uFF08\\uFF09()' +         // 〜「」（）
    '\\s\\-\\u2010-\\u2015' +        // 空白・ハイフンのなかま
    ']*$');
  KS.isKana = function (s) { return KANA_RE.test(String(s || '')); };

  KS.fmtTime = function (sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  KS.uuid = function () {
    var c = window.crypto || window.msCrypto;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var hex = [];
    for (var j = 0; j < 16; j++) hex.push((b[j] + 0x100).toString(16).slice(1));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-' +
           hex.slice(8, 10).join('') + '-' + hex.slice(10).join('');
  };

  // 端末のおおまかな種類（機種の調子を見るための参考情報）
  KS.device = function () {
    var ua = navigator.userAgent || '';
    var os = 'その他', m;
    if ((m = /iPhone OS (\d+)[_.](\d+)/.exec(ua))) os = 'iPhone iOS ' + m[1] + '.' + m[2];
    else if ((m = /iPad.*OS (\d+)[_.](\d+)/.exec(ua))) os = 'iPad iOS ' + m[1] + '.' + m[2];
    else if ((m = /Android (\d+(?:\.\d+)?)/.exec(ua))) os = 'Android ' + m[1];
    else if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = (navigator.maxTouchPoints > 1) ? 'iPad' : 'Mac';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    var br = 'ブラウザ不明';
    if ((m = /(?:EdgA?|EdgiOS)\/(\d+)/.exec(ua))) br = 'Edge ' + m[1];
    else if ((m = /SamsungBrowser\/(\d+)/.exec(ua))) br = 'Samsung Internet ' + m[1];
    else if ((m = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua))) br = 'Firefox ' + m[1];
    else if (/Line\//.test(ua)) br = 'LINE内ブラウザ';
    else if ((m = /(?:Chrome|CriOS)\/(\d+)/.exec(ua))) br = 'Chrome ' + m[1];
    else if ((m = /Version\/(\d+(?:\.\d+)?).*Safari/.exec(ua))) br = 'Safari ' + m[1];
    return os + ' / ' + br;
  };

  /* ---------- 端末への保存（小さなもの） ---------- */

  var mem = {};
  KS.store = {
    get: function (key, def) {
      try {
        var v = window.localStorage.getItem('ks1:' + key);
        return v === null ? (key in mem ? mem[key] : def) : JSON.parse(v);
      } catch (e) { return key in mem ? mem[key] : def; }
    },
    set: function (key, val) {
      mem[key] = val;
      try { window.localStorage.setItem('ks1:' + key, JSON.stringify(val)); } catch (e) { /* 保存できなくても続ける */ }
    },
    remove: function (key) {
      delete mem[key];
      try { window.localStorage.removeItem('ks1:' + key); } catch (e) { /* 何もしない */ }
    }
  };

  /* ---------- 知らせあい ---------- */

  var listeners = {};
  KS.bus = {
    on: function (evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
      return function () { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; }); };
    },
    emit: function (evt, data) {
      (listeners[evt] || []).slice().forEach(function (fn) {
        try { fn(data); } catch (e) { if (window.console) console.error(e); }
      });
    }
  };

  KS.wait = function (ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); };

  KS.reducedMotion = function () {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  /* ---------- 押しまちがいを防ぐ ---------- */

  // 画面や確認の窓が切りかわった直後の「押す」は受けつけない。
  // （ボタンを2回続けて押したとき、2回目が、新しく出た画面のボタンに当たってしまうのを防ぐ）
  var cfg = window.KS_CONFIG || {};
  var TAP_GUARD_MS = (typeof cfg.tapGuardMs === 'number' && cfg.tapGuardMs >= 0) ? cfg.tapGuardMs : 400;
  var guardUntil = 0;
  KS.guardTaps = function (ms) {
    var until = Date.now() + (typeof ms === 'number' ? ms : TAP_GUARD_MS);
    if (until > guardUntil) guardUntil = until;
  };
  document.addEventListener('click', function (e) {
    // 人が押したものだけを止める（プログラムが出す click は通す）
    if (e.isTrusted !== false && Date.now() < guardUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  /* ---------- 確認の窓・ひとこと ---------- */

  var openDialogs = [];
  // 開いている確認の窓をすべて閉じる（画面を切りかえるとき）
  KS.closeDialogs = function () {
    openDialogs.slice().forEach(function (close) { close(null); });
  };

  // KS.dialog({title, body, actions:[{label, value, kind}]}) → 押されたボタンの value（閉じたら null）
  KS.dialog = function (opt) {
    var h = KS.h;
    return new Promise(function (resolve) {
      var layer = document.getElementById('layer');
      var prev = document.activeElement;
      var done = false;
      function close(value) {
        if (done) return;
        done = true;
        openDialogs = openDialogs.filter(function (c) { return c !== close; });
        document.removeEventListener('keydown', onKey, true);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (!openDialogs.length) document.body.classList.remove('has-dialog');
        KS.guardTaps();
        if (prev && prev.focus && document.body.contains(prev)) { try { prev.focus(); } catch (e) { /* 何もしない */ } }
        resolve(value);
      }
      function onKey(e) {
        if (openDialogs[openDialogs.length - 1] !== close) return;     // いちばん上の窓だけが受けつける
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Tab') {
          var f = box.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])');
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      var body = opt.body;
      if (typeof body === 'string') body = h('p', { class: 'dialog__text', text: body });
      var buttons = (opt.actions || [{ label: 'とじる', value: true, kind: 'primary' }]).map(function (a) {
        return h('button', {
          type: 'button',
          class: 'btn ' + (a.kind === 'primary' ? 'btn--primary' : a.kind === 'danger' ? 'btn--danger' : 'btn--plain'),
          onclick: function () { close(a.value); }
        }, a.label);
      });
      var titleId = 'dlg-' + Math.random().toString(36).slice(2, 8);
      var box = h('div', { class: 'dialog' + (opt.sheet ? ' dialog--sheet' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        opt.art ? h('div', { class: 'dialog__art', svg: opt.art, 'aria-hidden': 'true' }) : null,
        h('h2', { class: 'dialog__title', id: titleId, text: opt.title || '' }),
        body,
        h('div', { class: 'dialog__actions' + (buttons.length > 2 ? ' dialog__actions--stack' : '') }, buttons)
      );
      var wrap = h('div', { class: 'dialog-wrap', onclick: function (e) { if (e.target === wrap) close(null); } }, box);
      layer.appendChild(wrap);
      openDialogs.push(close);
      document.body.classList.add('has-dialog');
      document.addEventListener('keydown', onKey, true);
      KS.guardTaps();
      var target = box.querySelector('.btn--primary') || box.querySelector('button');
      if (target) target.focus();
    });
  };

  var toastTimer = null;
  KS.toast = function (msg) {
    var layer = document.getElementById('layer');
    var old = layer.querySelector('.toast');
    if (old) layer.removeChild(old);
    var el = KS.h('div', { class: 'toast', role: 'status', text: msg });
    layer.appendChild(el);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3600);
  };
})();
