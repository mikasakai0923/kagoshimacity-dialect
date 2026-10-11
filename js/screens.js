/* かごしま ことばさんぽ — 画面 */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};
  var h = KS.h;
  var cfg = window.KS_CONFIG || {};
  var S = KS.screens = {};

  /* ============================================================
   * 共通の部品
   * ============================================================ */

  function siteName() { return String(cfg.siteName || 'かごしま ことばさんぽ'); }

  function titleLines(cls) {
    var parts = siteName().split(/[\s　]+/).filter(Boolean);
    var el = h('h1', { class: cls });
    parts.forEach(function (p) { el.appendChild(h('span', { class: cls + '-line', text: p })); });
    return el;
  }

  // 案内役のふきだし
  function say(pose, content, small) {
    return h('div', { class: 'say' + (small ? ' say--small' : '') },
      h('div', { class: 'say__who', svg: KS.art.daikon(pose) }),
      h('div', { class: 'say__bubble' }, content));
  }

  function iconButton(svg, label, onclick, cls) {
    return h('button', { type: 'button', class: 'iconbtn ' + (cls || ''), 'aria-label': label, title: label, onclick: onclick, svg: svg });
  }

  function demoBanner() {
    if (!KS.api.demo) return null;
    return h('p', { class: 'demo-banner' }, h('strong', { text: 'お試しモード' }), '　回答や録音は、どこにも送られません。');
  }

  // イラスト。「イラスト」欄の書き方： tree / boy rock dash / me > town / atama.png / https://…/x.png
  function scene(spec) {
    var text = String(spec || '').trim();
    if (!text) return null;
    var wrap = h('div', { class: 'scene', 'aria-hidden': 'true' });
    var count = 0;
    text.split('/').forEach(function (g) {
      var isUrlPart = false;
      var toks = g.trim().split(/\s+/).filter(Boolean);
      if (!toks.length) return;
      var group = h('div', { class: 'scene__group' });
      toks.forEach(function (tok) {
        if (tok === '>') { group.appendChild(h('span', { class: 'scene__arrow', svg: KS.icons.arrow })); return; }
        var m = /^(.+?)(?:\*(\d+(?:\.\d+)?))?$/.exec(tok);
        var name = m[1], scale = m[2] ? Math.max(0.4, Math.min(1.6, parseFloat(m[2]))) : 1;
        var src = null;
        if (/^[A-Za-z0-9_-]+$/.test(name)) src = 'images/icons/' + name + '.svg';
        else if (/^[A-Za-z0-9_\-][A-Za-z0-9_\-.]*\.(png|jpe?g|gif|webp|svg)$/i.test(name)) { src = 'images/' + name; isUrlPart = true; }
        if (!src) return;
        var img = h('img', { class: 'scene__img' + (isUrlPart ? ' scene__img--photo' : ''), src: src, alt: '', decoding: 'async' });
        if (scale !== 1) img.style.setProperty('--scale', String(scale));
        img.addEventListener('error', function () { img.style.display = 'none'; });
        group.appendChild(img);
        count++;
      });
      if (group.childNodes.length) wrap.appendChild(group);
    });
    // 「https://…」で始まる画像のアドレスが1つだけ書いてある場合
    if (!count && /^https:\/\/[^\s"'<>]+$/i.test(text)) {
      var photo = h('img', { class: 'scene__img scene__img--photo', src: text, alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
      photo.addEventListener('error', function () { wrap.style.display = 'none'; });
      wrap.appendChild(h('div', { class: 'scene__group' }, photo));
      count = 1;
    }
    return count ? wrap : null;
  }

  // 送信の状態（うしろで送っている回答の数）
  function syncPill() {
    var el = h('button', { type: 'button', class: 'pill', onclick: function () { explainSync(); } });
    function draw(st) {
      st = st || KS.sync.status();
      var icon, text, cls = 'pill';
      if (KS.api.demo) { icon = KS.icons.cloudOff; text = 'お試しモード'; cls += ' pill--demo'; }
      else if (st.pending === 0 && st.failed === 0) { icon = KS.icons.cloudOk; text = '送信ずみ'; cls += ' pill--ok'; }
      else if (st.state === 'sending') { icon = KS.icons.cloudUp; text = '送信中 ' + st.pending + '件'; cls += ' pill--busy'; }
      else { icon = KS.icons.cloudOff; text = '未送信 ' + (st.pending + st.failed) + '件'; cls += ' pill--wait'; }
      el.className = cls;
      el.innerHTML = '';
      KS.append(el, [h('span', { class: 'pill__icon', svg: icon }), h('span', { text: text })]);
    }
    var off = KS.bus.on('sync', draw);
    draw();
    return { el: el, destroy: off };
  }

  function explainSync() {
    var st = KS.sync.status();
    if (KS.api.demo) {
      return KS.dialog({ title: 'お試しモード', body: 'いまは見本として動いています。回答や録音は、どこにも送られません。', actions: [{ label: 'とじる', value: 1, kind: 'primary' }] });
    }
    if (st.pending === 0 && st.failed === 0) {
      return KS.dialog({ title: '送信ずみ', body: 'これまでの回答と録音は、すべて送信されています。', actions: [{ label: 'とじる', value: 1, kind: 'primary' }] });
    }
    var body = h('div', {},
      h('p', { class: 'dialog__text', text: 'まだ送られていない回答が ' + (st.pending + st.failed) + '件 あります。回答はこの端末の中に残っていて、通信できるときに自動で送られます。' }),
      h('p', { class: 'dialog__text', text: '電波のよい場所で、この画面を開いたまま少しお待ちください。' }),
      st.message ? h('p', { class: 'dialog__text dialog__text--sub', text: '（' + st.message + '）' }) : null);
    return KS.dialog({ title: '送信の状態', body: body, actions: [{ label: 'とじる', value: 0 }, { label: 'いま送り直す', value: 1, kind: 'primary' }] })
      .then(function (v) { if (v === 1) KS.sync.retryFailed(); });
  }

  /* ============================================================
   * 紹介ページ
   * ============================================================ */
  S.intro = function () {
    var loggedIn = !!KS.state.session;
    function paras(list) { return (list || []).map(function (t) { return h('p', { text: t }); }); }
    var el = h('main', { class: 'intro' },
      h('section', { class: 'hero' },
        h('div', { class: 'hero__art', svg: KS.art.hero() }),
        titleLines('hero__title'),
        h('p', { class: 'hero__lead', text: cfg.lead || '' }),
        h('button', {
          type: 'button', class: 'btn btn--primary btn--big',
          onclick: function () { KS.app.go(loggedIn ? '#/map' : '#/login'); }
        }, loggedIn ? 'つづきから歩く' : 'ログインしてはじめる'),
        demoBanner()
      ),
      h('section', { class: 'info' },
        h('h2', { text: 'どんな調査？' }), paras(cfg.about)),
      h('section', { class: 'info' },
        h('h2', { text: 'すすめかた' }),
        h('ol', { class: 'howto' },
          h('li', {}, h('span', { class: 'howto__n', text: '1' }), h('span', { text: '参加者ナンバーとパスワードでログインします。' })),
          h('li', {}, h('span', { class: 'howto__n', text: '2' }), h('span', { text: 'すごろくの道を、1歩ずつ進みます。1歩は10問くらいです。' })),
          h('li', {}, h('span', { class: 'howto__n', text: '3' }), h('span', { text: '1問ごとに、ひらがなで書いて、声を録音します。' })),
          h('li', {}, h('span', { class: 'howto__n', text: '4' }), h('span', { text: 'とちゅうでやめても、つづきから始められます。' })))),
      h('section', { class: 'info' },
        h('h2', { text: '用意するもの' }),
        h('ul', { class: 'bullets' },
          h('li', { text: 'スマートフォン（またはマイクのついたパソコン）' }),
          h('li', { text: 'できるだけ静かな場所' }),
          h('li', { text: '登録のときにお伝えした、参加者ナンバーとパスワード' }))),
      h('section', { class: 'info' },
        h('h2', { text: '回答と声のあつかい' }), paras(cfg.dataPolicy)),
      h('section', { class: 'info' },
        h('h2', { text: 'お問い合わせ' }),
        h('p', { text: cfg.organizer ? '実施：' + cfg.organizer : '実施者：（準備中）' }),
        h('p', { text: cfg.contact ? '連絡先：' + cfg.contact : '連絡先：（準備中）' })),
      h('footer', { class: 'credits' },
        h('p', { text: 'イラストの一部：Twemoji（CC BY 4.0）／文字：Zen Maru Gothic・Mochiy Pop One（SIL OFL 1.1）' }),
        h('p', { text: 'バージョン ' + KS.VERSION }))
    );
    return { el: el, title: siteName() };
  };

  /* ============================================================
   * ログイン
   * ============================================================ */
  S.login = function (opt) {
    opt = opt || {};
    var idInput = h('input', {
      class: 'field__input', id: 'login-id', type: 'text', name: 'username', autocomplete: 'username',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', maxlength: '40'
    });
    var pwInput = h('input', {
      class: 'field__input', id: 'login-pw', type: 'password', name: 'password', autocomplete: 'current-password',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', maxlength: '80'
    });
    var showBtn = h('button', { type: 'button', class: 'field__toggle', 'aria-pressed': 'false', onclick: function () {
      var show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      showBtn.textContent = show ? 'かくす' : '表示';
      showBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
    } }, '表示');
    var errEl = h('p', { class: 'form-error', role: 'alert' });
    var submitBtn = h('button', { type: 'submit', class: 'btn btn--primary btn--big' }, 'ログイン');
    var busy = false;

    var last = KS.store.get('lastId', '');
    if (last) idInput.value = last;
    if (opt.message) errEl.textContent = opt.message;

    function onSubmit(e) {
      e.preventDefault();
      if (busy) return;
      var id = KS.normId(idInput.value), pw = KS.norm(pwInput.value);
      if (!id) { errEl.textContent = '参加者ナンバーを入れてください。'; idInput.focus(); return; }
      if (!pw) { errEl.textContent = 'パスワードを入れてください。'; pwInput.focus(); return; }
      busy = true; errEl.textContent = '';
      submitBtn.disabled = true; submitBtn.textContent = 'たしかめています…';
      KS.app.login(id, pw).then(function () {
        KS.app.go('#/map');
      }, function (err) {
        busy = false;
        submitBtn.disabled = false; submitBtn.textContent = 'ログイン';
        errEl.textContent = (err && err.message) || 'ログインできませんでした。もう一度お試しください。';
        if (err && err.code === 'bad_credentials') { pwInput.value = ''; pwInput.focus(); }
      });
    }

    var el = h('main', { class: 'page page--login' },
      h('div', { class: 'topbar' },
        iconButton(KS.icons.back, '紹介ページにもどる', function () { KS.app.go('#/'); }),
        h('span', { class: 'topbar__title', text: siteName() }), h('span', { class: 'topbar__spacer' })),
      say('wave', h('p', { text: '登録のときにお伝えした、参加者ナンバーとパスワードを入れてください。' })),
      h('form', { class: 'card form', onsubmit: onSubmit, novalidate: true },
        h('div', { class: 'field' },
          h('label', { class: 'field__label', for: 'login-id', text: '参加者ナンバー' }), idInput),
        h('div', { class: 'field' },
          h('label', { class: 'field__label', for: 'login-pw', text: 'パスワード' }),
          h('div', { class: 'field__row' }, pwInput, showBtn)),
        errEl,
        submitBtn),
      KS.api.demo
        ? h('p', { class: 'demo-banner' }, h('strong', { text: 'お試しモード' }), '　好きな文字（たとえば「K001」と「0000」）を入れるとログインできます。')
        : h('p', { class: 'hint', text: 'ナンバーやパスワードがわからないときは、調査の担当者におたずねください。' })
    );
    return { el: el, title: 'ログイン', focus: last ? pwInput : idInput };
  };

  /* ============================================================
   * すごろくの地図
   * ============================================================ */
  S.map = function () {
    var app = KS.app, state = KS.state;
    var pill = syncPill();
    var offs = [];
    var boardWrap = h('div', { class: 'board' });
    var headWrap = h('div', {});
    var warnWrap = h('div', {});
    var resizeTimer = null;

    function header() {
      var steps = app.steps();
      var doneSteps = steps.filter(function (s) { return app.stepInfo(s.no).complete; }).length;
      var remain = app.remainingCount();
      var allDone = steps.length > 0 && doneSteps === steps.length;
      headWrap.innerHTML = '';
      headWrap.appendChild(h('section', { class: 'journey' },
        h('div', { class: 'journey__art', svg: KS.art.sakurajima(doneSteps, steps.length || 1, false) }),
        h('p', { class: 'journey__main' },
          allDone ? 'さいごまで歩きました' : [String(steps.length), '歩のうち ', h('strong', { text: String(doneSteps) }), '歩 あるきました']),
        h('p', { class: 'journey__sub', text: allDone ? 'ご協力ありがとうございました。' : 'のこり ' + remain + '問' })
      ));
    }

    function warn() {
      warnWrap.innerHTML = '';
      var st = KS.sync.status();
      var notice = state.survey && state.survey.settings && state.survey.settings.notice;
      if (notice) warnWrap.appendChild(h('p', { class: 'notice', text: notice }));
      if (!KS.api.demo && (st.pending + st.failed) > 0 && st.state !== 'sending') {
        warnWrap.appendChild(h('button', { type: 'button', class: 'notice notice--warn', onclick: explainSync },
          h('span', { class: 'notice__icon', svg: KS.icons.cloudOff }),
          h('span', { text: 'まだ送られていない回答が ' + (st.pending + st.failed) + '件 あります。電波のよい場所で、この画面を開いたままお待ちください。' })));
      }
      if (state.micOff) {
        warnWrap.appendChild(h('p', { class: 'notice' },
          '録音なしで回答しています。',
          h('button', { type: 'button', class: 'linkbtn', onclick: function () { app.go('#/practice'); } }, 'マイクをためす')));
      }
    }

    function board() {
      var steps = app.steps();
      var nodes = [{ kind: 'start' }];
      steps.forEach(function (s) { nodes.push({ kind: 'step', step: s, info: app.stepInfo(s.no) }); });
      nodes.push({ kind: 'goal' });

      var W = Math.max(280, Math.min(boardWrap.clientWidth || 360, 520));
      var T = W < 360 ? 78 : 88;                 // マスの大きさ
      var RH = 138;                              // マスどうしの縦の間かく
      var top = 100;
      var amp = Math.min(W * 0.27, 124);
      var cx = W / 2;
      var current = app.currentNode();           // 'start' | 歩の番号 | 'goal'
      var pts = nodes.map(function (n, i) {
        var off = n.kind === 'goal' ? 0 : (n.kind === 'start' ? -amp * 0.55 : Math.sin((i - 1) * 1.15 + 0.5) * amp);
        return { x: cx + off, y: top + i * RH };
      });
      var H = top + (nodes.length - 1) * RH + 96;

      boardWrap.innerHTML = '';
      boardWrap.style.height = H + 'px';

      // 道
      function seg(a, b) { var my = (a.y + b.y) / 2; return 'M' + a.x + ' ' + a.y + 'C' + a.x + ' ' + my + ' ' + b.x + ' ' + my + ' ' + b.x + ' ' + b.y; }
      var road = '', walked = '';
      for (var i = 0; i < pts.length - 1; i++) {
        road += seg(pts[i], pts[i + 1]);
        var from = nodes[i], doneFrom = from.kind === 'start' ? state.practiceDone : (from.kind === 'step' && from.info.complete);
        if (doneFrom) walked += seg(pts[i], pts[i + 1]);
      }
      // 海（あがりの手前）
      var seaY = pts[pts.length - 1].y - RH * 0.5;
      boardWrap.appendChild(h('div', {
        class: 'board__road', 'aria-hidden': 'true',
        svg: '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" focusable="false">' +
          '<path d="M-10 ' + (seaY - 20) + 'q' + (W / 8) + ' -14 ' + (W / 4) + ' 0t' + (W / 4) + ' 0t' + (W / 4) + ' 0t' + (W / 4 + 20) + ' 0v40q-' + (W / 8) + ' 14 -' + (W / 4) + ' 0t-' + (W / 4) + ' 0t-' + (W / 4) + ' 0t-' + (W / 4 + 20) + ' 0z" fill="#BFE7F2"/>' +
          '<path d="' + road + '" fill="none" stroke="#fff" stroke-width="18" stroke-linecap="round"/>' +
          (walked ? '<path d="' + walked + '" fill="none" stroke="#9BDDB9" stroke-width="18" stroke-linecap="round"/>' : '') +
          '<path d="' + road + '" fill="none" stroke="#1D2B53" stroke-width="3" stroke-dasharray="1 13" stroke-linecap="round"/>' +
          '</svg>'
      }));

      nodes.forEach(function (n, i) {
        var p = pts[i];
        var side = p.x < cx - 1 ? 'right' : (p.x > cx + 1 ? 'left' : 'right');
        var isCurrent = (n.kind === 'start' && current === 'start') || (n.kind === 'step' && current === n.step.no) || (n.kind === 'goal' && current === 'goal');
        var cls = 'tile', inner, label, onclick, aria;

        if (n.kind === 'start') {
          var pd = state.practiceDone;
          cls += pd ? ' tile--done' : ' tile--current';
          inner = h('span', { class: 'tile__icon', svg: KS.art.flag(pd ? '#fff' : '#FFD84D') });
          label = [h('span', { class: 'tile__no', text: 'ふりだし' }), h('span', { class: 'tile__title', text: '録音のれんしゅう' }),
                   h('span', { class: 'tile__meta', text: pd ? 'できました' : 'ここから' })];
          aria = 'ふりだし：録音のれんしゅう。' + (pd ? 'できました' : 'ここから始めます');
          onclick = function () { app.go('#/practice'); };
        } else if (n.kind === 'goal') {
          var all = current === 'goal';
          cls += all ? ' tile--goal tile--done' : ' tile--goal tile--locked';
          inner = h('img', { class: 'tile__img', src: 'images/icons/volcano.svg', alt: '' });
          label = [h('span', { class: 'tile__no', text: 'あがり' }), h('span', { class: 'tile__title', text: all ? 'おつかれさまでした' : '桜島' })];
          aria = 'あがり。' + (all ? 'さいごまで歩きました' : 'まだ進めません');
          onclick = function () { if (all) app.go('#/done'); else KS.toast('すべての歩を歩きおえると、あがりです。'); };
        } else {
          var info = n.info, s = n.step;
          var locked = !info.unlocked;
          cls += info.complete ? ' tile--done' : (locked ? ' tile--locked' : ' tile--current');
          inner = s.icon && /^[A-Za-z0-9_-]+$/.test(s.icon)
            ? h('img', { class: 'tile__img', src: 'images/icons/' + s.icon + '.svg', alt: '' })
            : h('span', { class: 'tile__num', text: String(s.no) });
          var meta = info.complete ? 'できました' : (info.done > 0 ? 'のこり ' + (info.total - info.done) + '問' : info.total + '問');
          label = [h('span', { class: 'tile__no', text: s.no + '歩目' }), s.title ? h('span', { class: 'tile__title', text: s.title }) : null,
                   h('span', { class: 'tile__meta', text: meta })];
          aria = s.no + '歩目 ' + (s.title || '') + '。' + (locked ? 'まだ進めません' : meta);
          onclick = function () { openStep(s, info); };
        }

        var btn = h('button', { type: 'button', class: cls + (isCurrent ? ' tile--here' : ''), 'aria-label': aria, onclick: onclick,
          style: { left: (p.x - T / 2) + 'px', top: (p.y - T / 2) + 'px', width: T + 'px', height: T + 'px' } }, inner,
          (n.kind !== 'goal' && cls.indexOf('tile--done') >= 0) ? h('span', { class: 'tile__stamp', svg: KS.art.stamp }) : null,
          cls.indexOf('tile--locked') >= 0 && n.kind === 'step' ? h('span', { class: 'tile__lock', svg: KS.icons.lock }) : null);
        boardWrap.appendChild(btn);

        var gap = 14;
        var labelStyle = side === 'right'
          ? { left: (p.x + T / 2 + gap) + 'px', top: (p.y - T / 2) + 'px', width: Math.max(90, W - (p.x + T / 2 + gap) - 4) + 'px', minHeight: T + 'px' }
          : { left: '4px', top: (p.y - T / 2) + 'px', width: Math.max(90, (p.x - T / 2 - gap) - 4) + 'px', minHeight: T + 'px' };
        boardWrap.appendChild(h('div', { class: 'tile-label tile-label--' + side + (cls.indexOf('tile--locked') >= 0 ? ' tile-label--locked' : ''), style: labelStyle, 'aria-hidden': 'true' }, label));

        if (isCurrent) {
          // 案内役は、マスの上に立つ（文字のない側に少し寄せる）
          var mx = p.x - 29 + (side === 'right' ? -20 : 20);
          mx = Math.max(0, Math.min(W - 60, mx));
          boardWrap.appendChild(h('div', { class: 'board__mascot', 'aria-hidden': 'true', svg: KS.art.daikon(n.kind === 'goal' ? 'cheer' : 'wave'),
            style: { left: mx + 'px', top: (p.y - T / 2 - 52) + 'px' } }));
        }
      });
    }

    function openStep(s, info) {
      if (!info.unlocked) { KS.toast('前の歩を歩きおえると、ここへ進めます。'); return; }
      var title = s.no + '歩目' + (s.title ? '　' + s.title : '');
      if (info.complete) {
        KS.dialog({
          title: title, sheet: true,
          body: 'この歩は歩きおわりました。答えを直したいときは、もう一度こたえることができます（前の回答も残ります）。',
          actions: [{ label: 'とじる', value: 0 }, { label: 'もう一度こたえる', value: 1, kind: 'primary' }]
        }).then(function (v) { if (v === 1) app.go('#/step/' + s.no + '/redo'); });
        return;
      }
      var started = info.done > 0;
      KS.dialog({
        title: title, sheet: true,
        body: started ? 'のこり ' + (info.total - info.done) + '問です。つづきから始めます。' : '全部で ' + info.total + '問あります。とちゅうでやめても、つづきから始められます。',
        actions: [{ label: 'とじる', value: 0 }, { label: started ? 'つづきから歩く' : 'はじめる', value: 1, kind: 'primary' }]
      }).then(function (v) { if (v === 1) app.go('#/step/' + s.no); });
    }

    function openMenu() {
      var body = h('div', { class: 'menu' },
        h('p', { class: 'dialog__text dialog__text--sub', text: '参加者ナンバー：' + (state.session ? state.session.id : '') }));
      var actions = [
        { label: '録音のれんしゅう（マイクのテスト）', value: 'practice' },
        { label: '使い方', value: 'help' }
      ];
      if (KS.api.demo) actions.push({ label: 'お試しの回答をCSVで保存', value: 'csv' });
      actions.push({ label: 'ログアウト', value: 'logout' });
      actions.push({ label: 'とじる', value: null, kind: 'primary' });
      KS.dialog({ title: 'メニュー', sheet: true, body: body, actions: actions }).then(function (v) {
        if (v === 'practice') app.go('#/practice');
        else if (v === 'help') showHelp();
        else if (v === 'csv') downloadCsv();
        else if (v === 'logout') app.confirmLogout();
      });
    }

    function redraw() { header(); warn(); board(); }

    var el = h('main', { class: 'page page--map' },
      h('h1', { class: 'sr-only', text: 'すごろくの地図' }),
      h('div', { class: 'topbar' },
        h('span', { class: 'who', text: (state.session ? state.session.id : '') + ' さん' }),
        h('span', { class: 'topbar__spacer' }),
        pill.el,
        iconButton(KS.icons.menu, 'メニュー', openMenu)),
      headWrap, warnWrap, boardWrap);

    offs.push(KS.bus.on('survey', redraw));
    offs.push(KS.bus.on('sync', warn));
    function onResize() { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(board, 150); }
    window.addEventListener('resize', onResize);

    return {
      el: el, title: '地図',
      mounted: function () {
        redraw();
        var here = boardWrap.querySelector('.tile--here');
        if (here && here.scrollIntoView && app.currentNode() !== 'start') {
          try { here.scrollIntoView({ block: 'center' }); } catch (e) { here.scrollIntoView(); }
        }
      },
      destroy: function () {
        offs.forEach(function (f) { f(); });
        pill.destroy();
        window.removeEventListener('resize', onResize);
        window.clearTimeout(resizeTimer);
      }
    };
  };

  function showHelp() {
    var body = h('div', {},
      h('ul', { class: 'bullets' },
        h('li', { text: '地図のマスを押すと、その歩の問題が始まります。' }),
        h('li', { text: '親しい人と話すときの、自然な方言で答えてください。' }),
        h('li', { text: '回答はひらがなで書き、マイクのボタンで声を録音します。' }),
        h('li', { text: '知らない・使わない・思い出せないときは、そのことを選んで次へ進めます。' }),
        h('li', { text: 'とちゅうでやめても、次に開いたときにつづきから始められます。' })));
    return KS.dialog({ title: '使い方', body: body, actions: [{ label: 'とじる', value: 1, kind: 'primary' }] });
  }

  function downloadCsv() {
    var blob = new Blob([KS.demoCsv()], { type: 'text/csv;charset=utf-8' });
    var url = window.URL.createObjectURL(blob);
    var a = h('a', { href: url, download: 'otameshi-kaitou.csv' });
    document.body.appendChild(a);
    a.click();
    window.setTimeout(function () { document.body.removeChild(a); window.URL.revokeObjectURL(url); }, 500);
    KS.toast('CSVを保存しました。');
  }

  /* ============================================================
   * ふりだし：録音のれんしゅう
   * ============================================================ */
  S.practice = function () {
    var app = KS.app;
    var rec = null;
    var after = h('div', { class: 'practice__after' });
    var recWrap = h('div', {});

    function makeRec() {
      if (rec) rec.destroy();
      rec = KS.recorderWidget({ name: 'れんしゅう', maxSec: 15, onchange: drawAfter, onerror: drawAfter });
      recWrap.innerHTML = '';
      recWrap.appendChild(rec.el);
    }
    function finish(micOff) {
      app.setMicOff(micOff);
      app.setPracticeDone();
      app.go('#/map');
    }
    function drawAfter() {
      after.innerHTML = '';
      if (rec && rec.getValue()) {
        after.appendChild(h('div', { class: 'card practice__check' },
          h('p', { class: 'practice__q', text: '「聞く」を押して、自分の声が聞こえるか確かめてください。' }),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn btn--plain', onclick: trouble }, '聞こえない'),
            h('button', { type: 'button', class: 'btn btn--primary', onclick: function () { finish(false); } }, '聞こえた'))));
      }
    }
    function trouble() {
      var body = h('div', {},
        h('ul', { class: 'bullets' },
          h('li', { text: '端末の音量を上げて、もう一度「聞く」を押してみてください。' }),
          h('li', { text: 'マイクの使用をたずねられたら「許可」を選んでください。' }),
          h('li', { text: 'LINE などのアプリの中で開いているときは、Safari や Chrome で開き直してください。' })),
        h('p', { class: 'dialog__text', text: 'どうしても録音できないときは、録音なしで進むこともできます。' }));
      KS.dialog({ title: '録音できないとき', body: body,
        actions: [{ label: '録音なしで進む', value: 'off' }, { label: 'もう一度ためす', value: 'retry', kind: 'primary' }] })
        .then(function (v) {
          if (v === 'retry') { makeRec(); drawAfter(); if (rec) rec.focus(); }
          else if (v === 'off') confirmOff();
        });
    }
    function confirmOff() {
      KS.dialog({
        title: '録音なしで進みますか？',
        body: '声の録音は、この調査でとても大切です。マイクの許可や音量を確かめても録音できないときだけ、録音なしで進んでください。',
        actions: [{ label: 'もう一度ためす', value: 0, kind: 'primary' }, { label: '録音なしで進む', value: 1 }]
      }).then(function (v) { if (v === 1) finish(true); });
    }

    var el = h('main', { class: 'page page--practice' },
      h('div', { class: 'topbar' },
        iconButton(KS.icons.close, '地図にもどる', function () { app.go('#/map'); }),
        h('span', { class: 'topbar__title', text: 'ふりだし' }), h('span', { class: 'topbar__spacer' })),
      h('h1', { class: 'page__title', text: '録音のれんしゅう' }),
      say('listen', [
        h('p', { text: '問題に入る前に、録音をためしてみましょう。' }),
        h('p', { text: '下のボタンを押して「こんにちは」と言い、言いおわったら、もう一度ボタンを押してください。' })]),
      h('div', { class: 'card' },
        h('p', { class: 'label', text: '録音（ボタンを押して、発音して、終わったらまたボタンを押してください）' }),
        recWrap),
      after,
      h('p', { class: 'hint' }, 'このれんしゅうの録音は、どこにも送られません。',
        h('button', { type: 'button', class: 'linkbtn', onclick: trouble }, '録音できないとき')));
    makeRec();
    return { el: el, title: '録音のれんしゅう', destroy: function () { if (rec) rec.destroy(); } };
  };

  /* ============================================================
   * 設問
   * ============================================================ */
  S.step = function (stepNo, redo) {
    var app = KS.app, state = KS.state;
    var set = (state.survey && state.survey.settings) || {};
    var step = app.stepByNo(stepNo);
    var all = app.stepItems(stepNo);
    var list = redo ? all.slice() : all.filter(function (it) { return !app.isDone(it.id); });
    var doneBefore = all.length - list.length;
    var index = 0;
    var recs = [];
    var shownAt = 0;
    var draft = null;
    var busy = false;

    var bar = h('div', { class: 'progress__fill' });
    var count = h('span', { class: 'progress__count' });
    var body = h('div', { class: 'q' });
    var el = h('main', { class: 'page page--step' },
      h('div', { class: 'topbar topbar--sticky' },
        iconButton(KS.icons.close, '地図にもどる', leave),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.length) }, bar),
        count),
      body);

    function destroyRecs() { recs.forEach(function (r) { r.destroy(); }); recs = []; }

    function hasContent() {
      if (!draft) return false;
      if (draft.status !== '回答済') return true;
      var any = false;
      body.querySelectorAll('input[type="text"], textarea').forEach(function (i) { if (KS.norm(i.value)) any = true; });
      recs.forEach(function (r) { if (r.getValue() || r.isBusy()) any = true; });
      return any;
    }

    function leave() {
      if (!hasContent()) { app.go('#/map'); return; }
      KS.dialog({
        title: '地図にもどりますか？',
        body: 'この問題に書いた内容は消えます。これまでに答えた問題は保存されています。',
        actions: [{ label: 'つづける', value: 0, kind: 'primary' }, { label: '地図にもどる', value: 1 }]
      }).then(function (v) { if (v === 1) app.go('#/map'); });
    }

    function questionLine(item) {
      var tpl = item.type === '語彙' ? (set.wordQuestion || '「{語}」のことをなんといいますか？') : (set.sentenceQuestion || '「{文}」をなんといいますか？');
      var m = /\{(語|文)\}/.exec(tpl);
      var el2 = h('h1', { class: 'q__title' });
      if (!m) {
        el2.appendChild(h('span', { class: 'q__prompt-wrap' }, h('span', { class: 'q__prompt' }, KS.ruby(item.prompt))));
        el2.appendChild(h('span', { class: 'q__rest', text: tpl }));
        return el2;
      }
      var before = tpl.slice(0, m.index), afterText = tpl.slice(m.index + m[0].length);
      // 「頭」の かぎかっこ は提示語といっしょに大きく見せる
      var open = /[「『]$/.test(before) ? before.slice(-1) : '', close = /^[」』]/.test(afterText) ? afterText.charAt(0) : '';
      if (open) before = before.slice(0, -1);
      if (close) afterText = afterText.slice(1);
      if (before) el2.appendChild(h('span', { class: 'q__rest', text: before }));
      var p = h('span', { class: 'q__prompt' });
      if (open) p.appendChild(document.createTextNode(open));
      p.appendChild(KS.ruby(item.prompt));
      if (close) p.appendChild(document.createTextNode(close));
      el2.appendChild(h('span', { class: 'q__prompt-wrap' }, p));
      if (afterText) el2.appendChild(h('span', { class: 'q__rest', text: afterText }));
      return el2;
    }

    function kanaField(id, labelText, opt) {
      opt = opt || {};
      var warnEl = h('p', { class: 'field__warn', role: 'status' });
      var input = h(opt.multiline ? 'textarea' : 'input', {
        class: 'field__input' + (opt.multiline ? ' field__input--area' : ''), id: id, type: opt.multiline ? null : 'text', lang: 'ja',
        autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'text',
        enterkeyhint: opt.multiline ? null : 'next', maxlength: '300', rows: opt.multiline ? '2' : null,
        oninput: function () {
          var v = input.value;
          warnEl.textContent = (!opt.free && v && !KS.isKana(v)) ? 'ひらがなで書いてください（漢字やローマ字が入っているようです）。' : '';
          input.classList.remove('field__input--missing');
          clearError();
        }
      });
      var wrap = h('div', { class: 'field' },
        h('label', { class: 'field__label', for: id }, labelText, opt.optional ? h('span', { class: 'field__opt', text: '書かなくてもかまいません' }) : null),
        input, warnEl);
      return { el: wrap, input: input };
    }

    var errorEl = h('p', { class: 'form-error', role: 'alert' });
    function clearError() { errorEl.textContent = ''; }

    function recorderBlock(name, slot) {
      var wrap = h('div', { class: 'recbox' });
      function draw() {
        wrap.innerHTML = '';
        if (state.micOff) {
          wrap.appendChild(h('div', { class: 'rec rec--off' },
            h('span', { class: 'rec__officon', svg: KS.icons.mic }),
            h('div', { class: 'rec__body' },
              h('p', { class: 'rec__status', text: '録音なしで回答しています' }),
              h('button', { type: 'button', class: 'linkbtn', onclick: function () {
                app.setMicOff(false); redrawRecorders(); KS.toast('録音にもどしました。');
              } }, '録音にもどす'))));
          return null;
        }
        var r = KS.recorderWidget({
          name: name, maxSec: set.maxRecordSec || 30,
          onchange: function () { r.markMissing(false); clearError(); },
          onerror: function () { showMicHelp(true); }
        });
        r.slot = slot;
        wrap.appendChild(r.el);
        return r;
      }
      return { el: wrap, draw: draw };
    }
    var recBlocks = [];
    var micHelpBtn = null;
    function redrawRecorders() {
      destroyRecs();
      recBlocks.forEach(function (b) { var r = b.draw(); if (r) recs.push(r); });
      if (micHelpBtn) micHelpBtn.style.display = state.micOff ? 'none' : '';
    }
    function showMicHelp(emphasize) { if (micHelpBtn && emphasize) micHelpBtn.classList.add('linkbtn--strong'); }
    function askMicOff() {
      KS.dialog({
        title: '録音なしで進みますか？',
        body: '声の録音は、この調査でとても大切です。マイクの許可や音量を確かめても録音できないときだけ、録音なしで進んでください。',
        actions: [{ label: 'もう一度ためす', value: 0, kind: 'primary' }, { label: '録音なしで進む', value: 1 }]
      }).then(function (v) {
        if (v !== 1) return;
        app.setMicOff(true);
        redrawRecorders();
        clearError();
        KS.toast('録音なしで回答します。');
      });
    }

    function render() {
      destroyRecs();
      recBlocks = [];
      clearError();
      busy = false;
      var item = list[index];
      var pos = redo ? index : doneBefore + index;
      bar.style.width = Math.round((pos / all.length) * 100) + '%';
      bar.parentNode.setAttribute('aria-valuenow', String(pos));
      count.textContent = (pos + 1) + ' / ' + all.length;
      draft = { status: '回答済' };
      shownAt = Date.now();

      body.innerHTML = '';
      var isWord = item.type === '語彙';
      var pic = scene(item.art);
      var ctx = item.context ? h('p', { class: 'q__context' },
        /^読み/.test(item.context) ? null : h('span', { class: 'tag', text: '場面' }), KS.ruby(item.context)) : null;

      var formWrap = h('div', { class: 'q__form' });
      var statusWrap = h('div', { class: 'q__status' });
      var fields = {};

      function buildForm() {
        formWrap.innerHTML = '';
        recBlocks = [];
        fields = {};
        if (draft.status !== '回答済') {
          formWrap.appendChild(h('div', { class: 'card card--status' },
            h('p', { class: 'status-line' }, '「', h('strong', { text: draft.status }), '」として記録します。'),
            h('button', { type: 'button', class: 'linkbtn', onclick: function () { draft.status = '回答済'; buildForm(); redrawRecorders(); drawStatusLinks(); clearError(); } }, 'やっぱり回答する')));
          fields.note = kanaField('f-note', '気づいたことがあれば', { optional: true, free: true, multiline: true });
          formWrap.appendChild(h('div', { class: 'card' }, fields.note.el));
          return;
        }
        var recLabel = '録音（ボタンを押して、発音して、終わったらまたボタンを押してください）';
        if (isWord) {
          fields.answer = kanaField('f-answer', '回答（ひらがなで記入してください）');
          var rb = recorderBlock('回答', 'main');
          recBlocks.push(rb);
          formWrap.appendChild(h('div', { class: 'card' }, fields.answer.el, h('p', { class: 'label', text: recLabel }), rb.el));
          if (item.example) {
            fields.example = kanaField('f-example', '例文の回答（ひらがなで記入してください）');
            var rb2 = recorderBlock('例文', 'example');
            recBlocks.push(rb2);
            formWrap.appendChild(h('div', { class: 'card' },
              h('p', { class: 'q__example' }, h('span', { class: 'tag', text: '例文' }), h('span', { class: 'q__example-text' }, '「', KS.ruby(item.example), '」'), 'を、あなたの方言でいうと？'),
              fields.example.el, h('p', { class: 'label', text: '例文の' + recLabel }), rb2.el));
          }
          fields.note = kanaField('f-note', '他の言い方や、気づいたことがあれば', { optional: true, free: true, multiline: true });
          formWrap.appendChild(h('div', { class: 'card' }, fields.note.el));
        } else {
          var segs = (item.segments && item.segments.length) ? item.segments : [KS.plain(item.prompt)];
          fields.segs = [];
          var grid = h('div', { class: 'segs', role: 'group', 'aria-labelledby': 'segs-label' });
          segs.forEach(function (sg, i) {
            var id = 'f-seg-' + i;
            var input = h('input', {
              class: 'field__input seg__input', id: id, type: 'text', lang: 'ja', autocomplete: 'off', autocapitalize: 'off',
              autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', maxlength: '80',
              oninput: function () { clearError(); grid.classList.remove('segs--missing'); kanaCheck(); },
              onkeydown: function (e) {
                if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  var nx = fields.segs[i + 1];
                  if (nx) nx.focus(); else input.blur();
                }
              }
            });
            fields.segs.push(input);
            grid.appendChild(h('div', { class: 'seg' }, h('label', { class: 'seg__label', for: id }, KS.ruby(sg)), input));
          });
          var segWarn = h('p', { class: 'field__warn', role: 'status' });
          var kanaCheck = function () {
            var bad = fields.segs.some(function (i) { return i.value && !KS.isKana(i.value); });
            segWarn.textContent = bad ? 'ひらがなで書いてください（漢字やローマ字が入っているようです）。' : '';
          };
          fields.note = kanaField('f-note', '他に言い方があったら記入してください', { optional: true });
          var rb3 = recorderBlock('回答', 'main');
          recBlocks.push(rb3);
          formWrap.appendChild(h('div', { class: 'card' },
            h('p', { class: 'label', id: 'segs-label', text: '直訳（文節ごとにひらがなで記入）' }), grid, segWarn));
          formWrap.appendChild(h('div', { class: 'card' }, fields.note.el));
          formWrap.appendChild(h('div', { class: 'card' }, h('p', { class: 'label', text: recLabel }), rb3.el));
        }
      }

      function pickStatus() {
        KS.dialog({
          title: 'わからないとき', sheet: true,
          body: 'あてはまるものを選んでください。',
          actions: [
            { label: '知らない（聞いたことがない）', value: '知らない' },
            { label: '使わない（聞いたことはあるが、自分では言わない）', value: '使わない' },
            { label: '思い出せない（いまは出てこない）', value: '思い出せない' },
            { label: 'やめる', value: null, kind: 'primary' }
          ]
        }).then(function (v) {
          if (!v) return;
          draft.status = v;
          destroyRecs();
          buildForm();
          drawStatusLinks();
          clearError();
        });
      }

      micHelpBtn = h('button', { type: 'button', class: 'linkbtn', onclick: askMicOff }, 'マイクが使えないとき');
      function drawStatusLinks() {
        statusWrap.innerHTML = '';
        if (draft.status === '回答済') {
          statusWrap.appendChild(h('button', { type: 'button', class: 'linkbtn', onclick: pickStatus }, '知らない・使わない・思い出せないとき'));
          statusWrap.appendChild(micHelpBtn);
          micHelpBtn.style.display = state.micOff ? 'none' : '';
        }
      }

      var nextBtn = h('button', { type: 'button', class: 'btn btn--primary btn--big', onclick: function () { next(item, fields, nextBtn); } },
        index === list.length - 1 ? 'この歩をおえる' : 'つぎへ');

      body.appendChild(say('listen', h('p', { text: set.instruction || '' }), true));
      if (pic) body.appendChild(h('div', { class: 'q__pic' }, pic));
      body.appendChild(questionLine(item));
      if (ctx) body.appendChild(ctx);
      body.appendChild(formWrap);
      body.appendChild(statusWrap);
      body.appendChild(errorEl);
      body.appendChild(h('div', { class: 'q__next' }, nextBtn));

      buildForm();
      redrawRecorders();
      drawStatusLinks();
      window.scrollTo(0, 0);
      var title = body.querySelector('.q__title');
      if (title) { title.setAttribute('tabindex', '-1'); try { title.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ } }
    }

    function val(f) { return f ? KS.norm(f.input ? f.input.value : f.value) : ''; }

    function next(item, fields, nextBtn) {
      if (busy) return;
      clearError();
      var isWord = item.type === '語彙';
      var answered = draft.status === '回答済';
      var out = { status: draft.status, answer: '', segPrompt: '', segAnswer: '', exampleAnswer: '', note: val(fields.note), audio: [] };

      function fail(msg, focusEl) {
        errorEl.textContent = msg;
        if (focusEl && focusEl.focus) focusEl.focus();
        if (errorEl.scrollIntoView) { try { errorEl.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 何もしない */ } }
      }

      if (answered) {
        if (recs.some(function (r) { return r.isBusy(); })) return fail('録音を終えてから進んでください。');
        var emptyCells = 0;
        if (isWord) {
          out.answer = val(fields.answer);
          if (!out.answer) { fields.answer.input.classList.add('field__input--missing'); return fail('回答をひらがなで書いてください。', fields.answer.input); }
          if (fields.example) {
            out.exampleAnswer = val(fields.example);
            if (!out.exampleAnswer) { fields.example.input.classList.add('field__input--missing'); return fail('例文の回答を書いてください。', fields.example.input); }
          }
        } else {
          var parts = fields.segs.map(function (i) { return KS.norm(i.value).replace(/[｜|]/g, ' '); });
          emptyCells = parts.filter(function (p) { return !p; }).length;
          if (emptyCells === parts.length && !out.note) {
            fields.segs[0].parentNode.parentNode.classList.add('segs--missing');
            return fail('文節ごとの直訳か、他の言い方のどちらかを書いてください。', fields.segs[0]);
          }
          out.segPrompt = ((item.segments && item.segments.length) ? item.segments : [item.prompt]).map(KS.plain).join('｜');
          out.segAnswer = emptyCells === parts.length ? '' : parts.join('｜');
          out.answer = parts.filter(Boolean).join(' ');
        }
        if (!state.micOff) {
          for (var i = 0; i < recs.length; i++) {
            var v = recs[i].getValue();
            if (!v) { recs[i].markMissing(true); recs[i].focus(); return fail((recs.length > 1 ? (recs[i].slot === 'example' ? '例文の' : '回答の') : '') + '録音がまだです。マイクのボタンを押して録音してください。'); }
            out.audio.push({ slot: recs[i].slot, buffer: v.buffer, sampleRate: v.sampleRate, durationSec: v.durationSec, peak: v.peak,
              echoCancellation: v.echoCancellation, noiseSuppression: v.noiseSuppression, autoGainControl: v.autoGainControl });
          }
        } else {
          out.noAudioReason = 'マイクが使えない';
        }
        if (!isWord && emptyCells > 0 && emptyCells < fields.segs.length) {
          busy = true;
          KS.dialog({
            title: '書いていない文節があります',
            body: 'このまま進みますか？　あなたの方言でその部分を言わないときは、空欄のままでかまいません。',
            actions: [{ label: 'もどって書く', value: 0 }, { label: 'このまま進む', value: 1, kind: 'primary' }]
          }).then(function (v2) {
            busy = false;
            if (v2 === 1) commit(item, out, nextBtn);
            else { var first = fields.segs.filter(function (i) { return !KS.norm(i.value); })[0]; if (first) first.focus(); }
          });
          return;
        }
      }
      commit(item, out, nextBtn);
    }

    function commit(item, out, nextBtn) {
      busy = true;
      nextBtn.disabled = true;
      out.elapsedSec = Math.round((Date.now() - shownAt) / 100) / 10;
      KS.rec.stopAll();
      app.submit(item, out).then(function () {
        index++;
        if (index < list.length) { render(); return; }
        destroyRecs();
        if (redo) { KS.toast('もう一度こたえた内容を保存しました。'); app.go('#/map'); }
        else app.go('#/clear/' + stepNo);
      }, function () {
        busy = false;
        nextBtn.disabled = false;
        errorEl.textContent = '端末に保存できませんでした。もう一度「つぎへ」を押してください。';
      });
    }

    if (!step || !all.length) {
      body.appendChild(h('p', { class: 'hint', text: 'この歩には問題がありません。' }));
    } else if (!list.length) {
      // もう全部答えてある
      window.setTimeout(function () { app.go('#/map'); }, 0);
    } else {
      render();
    }

    return {
      el: el, title: stepNo + '歩目',
      guard: function () { return hasContent(); },
      destroy: function () { destroyRecs(); KS.rec.stopAll(); }
    };
  };

  /* ============================================================
   * 歩クリア・あがり
   * ============================================================ */
  S.clear = function (stepNo) {
    var app = KS.app;
    var steps = app.steps();
    var step = app.stepByNo(stepNo);
    var doneSteps = steps.filter(function (s) { return app.stepInfo(s.no).complete; }).length;
    var allDone = steps.length > 0 && doneSteps === steps.length;
    var info = step ? app.stepInfo(stepNo) : { total: 0 };
    var nextStep = null;
    for (var i = 0; i < steps.length; i++) if (!app.stepInfo(steps[i].no).complete) { nextStep = steps[i]; break; }
    var pill = syncPill();

    var el = h('main', { class: 'page page--clear' },
      h('div', { class: 'topbar' }, h('span', { class: 'topbar__spacer' }), pill.el),
      h('div', { class: 'clear' },
        h('div', { class: 'clear__art', svg: KS.art.sakurajima(doneSteps, steps.length || 1, true) }),
        h('div', { class: 'clear__mascot', svg: KS.art.daikon('cheer') }),
        h('h1', { class: 'clear__title' }, allDone ? 'あがり！' : [h('span', { text: stepNo + '歩目' }), h('span', { text: 'クリア！' })]),
        h('p', { class: 'clear__text', text: allDone
          ? 'さいごまで歩きました。ご協力ありがとうございました。'
          : (step && step.title ? step.title + 'まで歩きました。' : '') + info.total + '問こたえました。' }),
        KS.api.demo ? null : h('p', { class: 'clear__sub', text: '回答は自動で送信されます。右上が「送信ずみ」になるまで、この画面を開いておいてください。' }),
        h('div', { class: 'btn-col' },
          nextStep ? h('button', { type: 'button', class: 'btn btn--primary btn--big', onclick: function () { app.go('#/step/' + nextStep.no); } }, 'つぎの一歩へ') : null,
          h('button', { type: 'button', class: 'btn ' + (nextStep ? 'btn--plain' : 'btn--primary btn--big'), onclick: function () { app.go('#/map'); } }, '地図にもどる'))
      ),
      KS.reducedMotion() ? null : h('div', { class: 'confetti', 'aria-hidden': 'true' }, confetti())
    );
    return { el: el, title: allDone ? 'あがり' : stepNo + '歩目クリア', destroy: function () { pill.destroy(); } };
  };

  function confetti() {
    var colors = ['#FF9A2E', '#FFD84D', '#37B679', '#2AA9C9', '#FF9FB2'];
    var out = [];
    for (var i = 0; i < 26; i++) {
      out.push(h('span', { class: 'confetti__bit', style: {
        left: (4 + (i * 37) % 92) + '%', background: colors[i % colors.length],
        animationDelay: ((i * 53) % 700) + 'ms', animationDuration: (1500 + (i * 97) % 900) + 'ms',
        transform: 'rotate(' + ((i * 47) % 360) + 'deg)'
      } }));
    }
    return out;
  }
})();
