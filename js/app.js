/* かごしま ことばさんぽ — 全体の流れ（画面の切りかえ・ログイン・進み具合） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};
  var h = KS.h;
  var cfg = window.KS_CONFIG || {};
  var store = KS.store;

  var state = KS.state = {
    session: null,        // { id, token, expiresAt }
    survey: null,         // { settings, steps, items }
    progress: {},         // { 設問ID: { status, at } }
    practiceDone: false,  // 録音のれんしゅうを終えたか
    volatileMode: false   // 端末に回答をとっておけない状態か（そのあいだは、1問ごとに送信が終わるのを待つ）
  };
  var localMarks = {};    // この画面を開いてから答えた設問（保存先の返事が古くても「答えた」ままにする）
  var current = null;     // いま出ている画面
  var currentHash = null; // いま出ている画面のアドレス（#/…）
  var lastRefresh = 0;
  var refreshing = null, refreshingFor = '';
  var root = document.getElementById('app');

  function siteName() { return String(cfg.siteName || 'かごしま ことばさんぽ'); }
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function isAuthCode(err) {
    var code = err && err.code;
    return code === 'auth' || code === 'disabled' || code === 'closed';
  }

  /* ---------- 進み具合 ---------- */
  var app = KS.app = {};

  app.steps = function () { return (state.survey && state.survey.steps) || []; };
  app.stepByNo = function (no) {
    var s = app.steps();
    for (var i = 0; i < s.length; i++) if (s[i].no === no) return s[i];
    return null;
  };
  app.stepItems = function (no) {
    return ((state.survey && state.survey.items) || []).filter(function (it) { return it.step === no; });
  };
  app.isDone = function (itemId) { return has(state.progress, itemId) && !!state.progress[itemId]; };
  app.stepInfo = function (no) {
    var items = app.stepItems(no);
    var done = items.filter(function (it) { return app.isDone(it.id); }).length;
    var unlocked = state.practiceDone;
    var steps = app.steps();
    for (var i = 0; i < steps.length && unlocked; i++) {
      if (steps[i].no === no) break;
      var its = app.stepItems(steps[i].no);
      if (its.some(function (it) { return !app.isDone(it.id); })) unlocked = false;
    }
    return { total: items.length, done: done, complete: items.length > 0 && done === items.length, unlocked: unlocked };
  };
  app.remainingCount = function () {
    return ((state.survey && state.survey.items) || []).filter(function (it) { return !app.isDone(it.id); }).length;
  };
  // 地図の「いまここ」： 'start'（れんしゅう） / 歩の番号 / 'goal'
  app.currentNode = function () {
    if (!state.practiceDone) return 'start';
    var steps = app.steps();
    for (var i = 0; i < steps.length; i++) if (!app.stepInfo(steps[i].no).complete) return steps[i].no;
    return 'goal';
  };

  app.setPracticeDone = function () {
    state.practiceDone = true;
    if (state.session) store.set('practice:' + state.session.id, true);
  };

  /* ---------- 回答を出す ----------
   * ふつうは、端末にとっておいたらすぐ次へ進み、送信はうしろで行う。
   * 端末にとっておけなかったとき（保存場所がいっぱい・使えない など）は、保存先に届くまで待ってから進む。
   * opt.onwait … 「届くまで待つ」に入ったときに呼ぶ
   * opt.onretry … 待っているあいだに送信に失敗して、自動で送り直すことになったときに呼ぶ */
  app.submit = function (item, out, opt) {
    opt = opt || {};
    var s = state.session;
    if (!s) return Promise.reject(new KS.ApiError('auth', 'ログインしていません。'));
    var sid = KS.uuid();
    function mark() {
      if (!state.session || state.session.id !== s.id) return;
      var rec = { status: out.status, at: Date.now() };
      state.progress[item.id] = rec;
      localMarks[item.id] = rec;
      store.set('progress:' + s.id, state.progress);
      KS.bus.emit('survey');          // 地図が出ていれば、描き直す
    }
    var sub = {
      sid: sid,
      participant: s.id,
      itemId: item.id,
      step: item.step,
      type: item.type,
      prompt: KS.plain(item.prompt),
      status: out.status,
      answer: out.answer || '',
      segPrompt: out.segPrompt || '',
      segAnswer: out.segAnswer || '',
      exampleAnswer: out.exampleAnswer || '',
      note: out.note || '',
      noAudioReason: out.noAudioReason || '',
      elapsedSec: out.elapsedSec,
      clientTime: KS.jstStamp(),
      device: KS.device(),
      app: KS.VERSION,
      audio: out.audio || []
    };
    return KS.sync.enqueue(sub).then(function (res) {
      if (res && res.persisted) {
        state.volatileMode = false;
        mark();
        return { persisted: true };
      }
      state.volatileMode = true;
      if (opt.onwait) opt.onwait();
      return KS.sync.waitFor(sid, { onRetry: opt.onretry }).then(function () {
        mark();
        return { persisted: false };
      }, function (err) {
        // 何度送っても通らない回答は、とっておいても送れないので取り消す（直して出し直してもらう）
        if (err && (err.code === 'bad_request' || err.code === 'too_large')) KS.sync.discard(sid);
        throw err;
      });
    });
  };

  /* ---------- ログイン・ログアウト ---------- */
  function adoptSession(session) {
    state.session = session;
    state.survey = store.get('survey:' + session.id, null);
    state.progress = store.get('progress:' + session.id, {}) || {};
    state.practiceDone = !!store.get('practice:' + session.id, false);
    state.volatileMode = false;
    localMarks = {};
    lastRefresh = 0;
  }

  app.login = function (id, password) {
    return KS.api.login(id, password).then(function (res) {
      var session = { id: res.participant.id, token: res.token, expiresAt: res.expiresAt };
      store.set('session', session);
      store.set('lastId', session.id);
      adoptSession(session);
      return app.refresh().then(null, function (err) {
        // 調査の内容を読みこめなくても、前に読みこんだものがあれば、それで始める（あとで読みこみ直す）
        if (state.survey && !isAuthCode(err)) return;
        state.session = null;
        store.remove('session');
        throw err;
      });
    }).then(function () {
      KS.sync.kick();
    });
  };

  app.logout = function () {
    KS.rec.stopAll();
    store.remove('session');
    state.session = null; state.survey = null; state.progress = {}; state.practiceDone = false; state.volatileMode = false;
    localMarks = {};
    KS.sync.reset();
    KS.bus.emit('sync', KS.sync.status());
    app.replace('#/');
  };

  app.confirmLogout = function () {
    var st = KS.sync.status();
    var n = st.pending + st.failed;
    var body = '次に使うときは、もう一度、参加者ナンバーとパスワードを入れます。';
    if (!KS.api.demo && st.volatile > 0) {
      body = 'この端末に保存できていない回答が ' + st.volatile + '件 あります。送信が終わる前にこのページを閉じると、その回答は消えてしまいます。右上が「送信ずみ」になってからログアウトしてください。';
    } else if (!KS.api.demo && n > 0) {
      body = 'まだ送られていない回答が ' + n + '件 あります。ログアウトしても消えませんが、次に同じ参加者ナンバーでこの端末からログインするまで送られません。';
    }
    return KS.dialog({
      title: 'ログアウトしますか？',
      body: body,
      actions: [{ label: 'やめる', value: 0, kind: 'primary' }, { label: 'ログアウト', value: 1 }]
    }).then(function (v) { if (v === 1) app.logout(); });
  };

  /* ---------- 調査項目と進み具合を保存先から受け取る ---------- */
  app.refresh = function () {
    var s = state.session;
    if (!s) return Promise.reject(new KS.ApiError('auth', 'ログインしてください。'));
    if (refreshing && refreshingFor === s.token) return refreshing;
    function stillMine() { return !!state.session && state.session.token === s.token; }
    var p = KS.api.bootstrap(s.token).then(function (data) {
      return KS.sync.pendingItemIds().then(function (pendingIds) {
        if (!stillMine()) return;                 // 読みこみのあいだに、別のログインに変わっていた
        var progress = {};
        var got = data.progress || {};
        for (var k in got) if (has(got, k) && got[k]) progress[k] = { status: got[k].status, at: got[k].at };
        pendingIds.forEach(function (id) { if (!has(progress, id)) progress[id] = { status: '回答済', at: Date.now() }; });
        for (var m in localMarks) if (has(localMarks, m) && !has(progress, m)) progress[m] = localMarks[m];
        state.survey = { settings: data.settings || {}, steps: data.steps || [], items: data.items || [] };
        state.progress = progress;
        store.set('survey:' + s.id, state.survey);
        store.set('progress:' + s.id, progress);
        lastRefresh = Date.now();
        KS.bus.emit('survey');
      });
    }, function (err) {
      // ログインし直したあとで、前のログインでの読みこみが失敗しても、いまのログインには関係ない
      if (!stillMine()) throw new KS.ApiError('stale', '');
      throw err;
    });
    refreshing = p; refreshingFor = s.token;
    var done = function () { if (refreshing === p) { refreshing = null; refreshingFor = ''; } };
    p.then(done, done);
    return p;
  };

  /* ---------- 画面の切りかえ ----------
   * サイトの中の移動は、アドレス（#/…）を書きかえて、すぐ画面を出す。
   * ブラウザの「戻る」などでアドレスが変わったときだけ、hashchange の知らせで画面を出す。 */
  function parse(hash) {
    var path = String(hash || '').replace(/^#\/?/, '').replace(/\?.*$/, '');
    var parts = path.split('/').filter(Boolean);
    var name = parts[0] || 'intro';
    return { name: name, parts: parts };
  }
  function here() { return window.location.hash || '#/'; }
  function same(a, b) { return (a || '#/') === (b || '#/'); }

  var bypassGuard = false;
  function navigate(hash, replace) {
    if (!same(here(), hash)) {
      var ok = false;
      try { window.history[replace ? 'replaceState' : 'pushState'](null, '', hash); ok = true; } catch (e) { ok = false; }
      if (!ok) {
        // アドレスだけを書きかえられないブラウザ：ふつうに移動して、その知らせで画面を出す
        bypassGuard = true;
        if (replace) window.location.replace(hash); else window.location.hash = hash;
        return;
      }
    }
    render();
  }
  // 先の画面へ進む（「戻る」でもどって来られる）
  app.go = function (hash) { navigate(hash, false); };
  // いまの画面と入れかえる（「戻る」を押しても、この画面にはもどらない）
  app.replace = function (hash) { navigate(hash, true); };

  function mount(screen) {
    KS.closeDialogs();
    if (current && current.destroy) { try { current.destroy(); } catch (e) { if (window.console) console.error(e); } }
    KS.rec.stopAll();
    current = screen;
    currentHash = here();
    root.innerHTML = '';
    root.appendChild(screen.el);
    document.title = screen.title && screen.title !== siteName() ? screen.title + '｜' + siteName() : siteName();
    window.scrollTo(0, 0);
    var target = screen.focus || screen.el.querySelector('h1');
    if (target) {
      if (!target.hasAttribute('tabindex') && !/^(INPUT|BUTTON|TEXTAREA|A)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ }
    }
    if (screen.mounted) screen.mounted();      // 地図は、ここで「いまここ」のマスまで動かす（上の focus より後に行う）
    KS.guardTaps();
  }

  function loadingScreen(text) {
    return { el: h('main', { class: 'page page--center' },
      h('div', { class: 'loading' }, h('div', { class: 'loading__mascot', svg: KS.art.daikon('wave') }), h('p', { text: text || '読みこんでいます…' }))), title: siteName() };
  }
  function errorScreen(message) {
    return { el: h('main', { class: 'page page--center' },
      h('div', { class: 'loading' },
        h('p', { class: 'loading__msg', text: message }),
        h('div', { class: 'btn-col' },
          h('button', { type: 'button', class: 'btn btn--primary', onclick: function () { render(); } }, 'もう一度ためす'),
          h('button', { type: 'button', class: 'btn btn--plain', onclick: function () { app.go('#/'); } }, '紹介ページにもどる')))), title: siteName() };
  }

  function render() {
    var route = parse(window.location.hash);
    var name = route.name;
    var known = { intro: 1, login: 1, map: 1, practice: 1, step: 1, clear: 1, done: 1 };
    var needsLogin = { map: 1, practice: 1, step: 1, clear: 1, done: 1 };
    var redirect = app.replace;       // 開けない画面を開こうとしたとき：履歴に残さずに、開ける画面へ移る

    if (!has(known, name) || name === 'intro') return mount(KS.screens.intro());
    if (name === 'login') {
      if (state.session) return redirect('#/map');
      var loginMessage = app._loginMessage || '';
      app._loginMessage = '';
      return mount(KS.screens.login({ message: loginMessage }));
    }
    if (needsLogin[name] && !state.session) return redirect('#/login');

    if (!state.survey) {
      var loading = loadingScreen('調査の内容を読みこんでいます…');
      mount(loading);
      app.refresh().then(function () {
        if (current === loading) render();
      }, function (err) {
        if (handleAuthError(err)) return;
        if (current !== loading) return;
        if (err && err.code === 'stale') return render();
        mount(errorScreen((err && err.message) || '読みこめませんでした。'));
      });
      return;
    }
    // 開くたびに、古くなっていたら新しい内容を取りにいく（画面はすぐ出す）
    if (name === 'map' && Date.now() - lastRefresh > 120000) {
      app.refresh().then(null, function (err) { handleAuthError(err); });
    }

    if (name === 'map') return mount(KS.screens.map());
    if (name === 'practice') return mount(KS.screens.practice());
    if (name === 'step') {
      var no = parseInt(route.parts[1], 10);
      var info = app.stepByNo(no) ? app.stepInfo(no) : null;
      if (!info) return redirect('#/map');
      if (!state.practiceDone) return redirect('#/practice');
      if (!info.unlocked) return redirect('#/map');
      var redo = route.parts[2] === 'redo';
      if (redo && !info.complete) redo = false;
      if (!redo && info.complete) return redirect('#/map');       // もう全部答えてある
      return mount(KS.screens.step(no, redo));
    }
    if (name === 'clear') {
      var n = parseInt(route.parts[1], 10);
      if (!app.stepByNo(n) || !app.stepInfo(n).complete) return redirect('#/map');
      return mount(KS.screens.clear(n));
    }
    if (name === 'done') {
      var steps = app.steps();
      if (!steps.length || app.currentNode() !== 'goal') return redirect('#/map');
      return mount(KS.screens.clear(steps[steps.length - 1].no));
    }
    mount(KS.screens.intro());
  }

  function handleAuthError(err) {
    if (!isAuthCode(err)) return false;
    var msg = (err && err.message) || 'もう一度ログインしてください。';
    store.remove('session');
    state.session = null;
    KS.sync.reset();
    app._loginMessage = msg;
    app.replace('#/login');
    return true;
  }

  // 送信の途中で「ログインし直してください」などと言われたとき
  var blockedOpen = false;
  KS.bus.on('sync-blocked', function (err) {
    if (!state.session || blockedOpen) return;
    blockedOpen = true;
    var code = err && err.code;
    var st = KS.sync.status();
    var n = st.pending + st.failed;
    var title = code === 'closed' ? 'いまは受付を止めています' : (code === 'disabled' ? 'この参加者ナンバーは使えません' : 'もう一度ログインしてください');
    var rest = '';
    if (st.volatile > 0) rest = 'まだ送られていない回答が ' + n + '件 あります。このページを閉じずに、ログインし直してください。';
    else if (n > 0) rest = 'まだ送られていない回答 ' + n + '件 は、この端末に残っています。' + (code === 'auth' ? 'ログインし直すと送信されます。' : '次にログインできたときに送信されます。');
    KS.dialog({
      title: title,
      body: h('div', {},
        h('p', { class: 'dialog__text', text: (err && err.message) || '' }),
        rest ? h('p', { class: 'dialog__text', text: rest }) : null),
      actions: [{ label: 'ログイン画面へ', value: 1, kind: 'primary' }]
    }).then(function () { blockedOpen = false; handleAuthError(err); });
  });

  // ブラウザの「戻る」「進む」や、アドレスの書きかえで来たとき
  var askingLeave = false;
  function onHashChange() {
    if (bypassGuard) { bypassGuard = false; render(); return; }
    var wanted = here();
    if (current && current.guard && currentHash !== null && !same(wanted, currentHash) && current.guard()) {
      // 書きかけの回答がある：いまの画面にとどまって、はなれてよいかを確かめる
      var restored = false;
      try { window.history.pushState(null, '', currentHash); restored = true; } catch (e) { restored = false; }
      if (restored) {
        if (askingLeave) return;
        askingLeave = true;
        KS.dialog({
          title: 'この問題からはなれますか？',
          body: 'この問題に書いた内容や録音は消えます。これまでに答えた問題は保存されています。',
          actions: [{ label: 'つづける', value: 0, kind: 'primary' }, { label: 'はなれる', value: 1 }]
        }).then(function (v) {
          askingLeave = false;
          if (v === 1) navigate(wanted, true);
        });
        return;
      }
    }
    render();
  }
  window.addEventListener('hashchange', onHashChange);

  // ページを閉じる・読みこみ直すとき：書きかけの回答や、まだ送っていない回答があれば、ブラウザに確かめてもらう
  window.addEventListener('beforeunload', function (e) {
    var st = KS.sync.status();
    var unsent = !KS.api.demo && !!state.session && (st.volatile > 0 || (st.pending > 0 && st.state !== 'blocked'));
    var draft = !!(current && current.guard && current.guard());
    if (draft || unsent) { e.preventDefault(); e.returnValue = ''; return ''; }
    return undefined;
  });

  /* ---------- はじまり ---------- */
  function start() {
    try { if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'; } catch (e) { /* 何もしない */ }
    var session = store.get('session', null);
    if (session && session.token && session.expiresAt > Date.now() + 60000) adoptSession(session);
    else if (session) store.remove('session');

    if (state.session) KS.sync.kick();
    render();
  }

  try { start(); }
  catch (e) {
    if (window.console) console.error(e);
    var msg = document.getElementById('boot-msg');
    if (msg) msg.textContent = '画面を表示できませんでした。ページを読みこみ直してください。';
  }
})();
