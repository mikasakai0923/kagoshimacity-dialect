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
    micOff: false,        // 録音なしで回答しているか
    practiceDone: false   // 録音のれんしゅうを終えたか
  };
  var localMarks = {};    // この画面を開いてから答えた設問（保存先の返事が古くても「答えた」ままにする）
  var current = null;     // いま出ている画面
  var lastRefresh = 0;
  var refreshing = null;
  var root = document.getElementById('app');

  function siteName() { return String(cfg.siteName || 'かごしま ことばさんぽ'); }

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
  app.isDone = function (itemId) { return !!state.progress[itemId]; };
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

  app.setMicOff = function (off) {
    state.micOff = !!off;
    if (state.session) store.set('micoff:' + state.session.id, state.micOff);
  };
  app.setPracticeDone = function () {
    state.practiceDone = true;
    if (state.session) store.set('practice:' + state.session.id, true);
  };

  /* ---------- 回答を出す ---------- */
  app.submit = function (item, out) {
    var s = state.session;
    if (!s) return Promise.reject(new Error('ログインしていません'));
    var sub = {
      sid: KS.uuid(),
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
      clientTime: new Date().toISOString(),
      device: KS.device(),
      app: KS.VERSION,
      audio: out.audio || []
    };
    return KS.sync.enqueue(sub).then(function () {
      state.progress[item.id] = { status: out.status, at: Date.now() };
      localMarks[item.id] = state.progress[item.id];
      store.set('progress:' + s.id, state.progress);
    });
  };

  /* ---------- ログイン・ログアウト ---------- */
  function adoptSession(session) {
    state.session = session;
    state.survey = store.get('survey:' + session.id, null);
    state.progress = store.get('progress:' + session.id, {}) || {};
    state.micOff = !!store.get('micoff:' + session.id, false);
    state.practiceDone = !!store.get('practice:' + session.id, false);
    localMarks = {};
    lastRefresh = 0;
  }

  app.login = function (id, password) {
    return KS.api.login(id, password).then(function (res) {
      var session = { id: res.participant.id, token: res.token, expiresAt: res.expiresAt };
      store.set('session', session);
      store.set('lastId', session.id);
      adoptSession(session);
      return app.refresh();
    }).then(function () {
      KS.sync.kick();
    }, function (err) {
      if (state.session && !state.survey) { state.session = null; store.remove('session'); }
      throw err;
    });
  };

  app.logout = function () {
    KS.rec.stopAll();
    store.remove('session');
    state.session = null; state.survey = null; state.progress = {}; state.micOff = false; state.practiceDone = false;
    localMarks = {};
    KS.sync.reset();
    KS.bus.emit('sync', KS.sync.status());
    app.go('#/');
  };

  app.confirmLogout = function () {
    var st = KS.sync.status();
    var n = st.pending + st.failed;
    return KS.dialog({
      title: 'ログアウトしますか？',
      body: (!KS.api.demo && n > 0)
        ? 'まだ送られていない回答が ' + n + '件 あります。ログアウトしても消えませんが、次に同じ参加者ナンバーでこの端末からログインするまで送られません。'
        : '次に使うときは、もう一度、参加者ナンバーとパスワードを入れます。',
      actions: [{ label: 'やめる', value: 0, kind: 'primary' }, { label: 'ログアウト', value: 1 }]
    }).then(function (v) { if (v === 1) app.logout(); });
  };

  /* ---------- 調査項目と進み具合を保存先から受け取る ---------- */
  app.refresh = function () {
    var s = state.session;
    if (!s) return Promise.reject(new KS.ApiError('auth', 'ログインしてください。'));
    if (refreshing) return refreshing;
    refreshing = KS.api.bootstrap(s.token).then(function (data) {
      return KS.sync.pendingItemIds().then(function (pendingIds) {
        if (!state.session || state.session.id !== s.id) return;
        var progress = {};
        var p = data.progress || {};
        for (var k in p) progress[k] = { status: p[k].status, at: p[k].at };
        pendingIds.forEach(function (id) { if (!progress[id]) progress[id] = { status: '回答済', at: Date.now() }; });
        for (var m in localMarks) if (!progress[m]) progress[m] = localMarks[m];
        state.survey = { settings: data.settings || {}, steps: data.steps || [], items: data.items || [] };
        state.progress = progress;
        store.set('survey:' + s.id, state.survey);
        store.set('progress:' + s.id, progress);
        lastRefresh = Date.now();
        KS.bus.emit('survey');
      });
    });
    var done = function () { refreshing = null; };
    refreshing.then(done, done);
    return refreshing;
  };

  /* ---------- 画面の切りかえ ---------- */
  function parse(hash) {
    var path = String(hash || '').replace(/^#\/?/, '').replace(/\?.*$/, '');
    var parts = path.split('/').filter(Boolean);
    var name = parts[0] || 'intro';
    return { name: name, parts: parts };
  }

  app.go = function (hash) {
    if (window.location.hash === hash || (hash === '#/' && !window.location.hash)) render();
    else window.location.hash = hash;
  };

  function mount(screen) {
    if (current && current.destroy) { try { current.destroy(); } catch (e) { if (window.console) console.error(e); } }
    KS.rec.stopAll();
    current = screen;
    root.innerHTML = '';
    root.appendChild(screen.el);
    document.title = screen.title && screen.title !== siteName() ? screen.title + '｜' + siteName() : siteName();
    window.scrollTo(0, 0);
    if (screen.mounted) screen.mounted();
    var target = screen.focus || screen.el.querySelector('h1');
    if (target) {
      if (!target.hasAttribute('tabindex') && !/^(INPUT|BUTTON|TEXTAREA|A)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ }
    }
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
    var needsLogin = { map: 1, practice: 1, step: 1, clear: 1, done: 1 };

    if (name === 'intro' || !KS.screens[name === 'done' ? 'clear' : name]) return mount(KS.screens.intro());
    if (name === 'login') {
      if (state.session) return app.go('#/map');
      var loginMessage = app._loginMessage || '';
      app._loginMessage = '';
      return mount(KS.screens.login({ message: loginMessage }));
    }
    if (needsLogin[name] && !state.session) return app.go('#/login');

    if (!state.survey) {
      mount(loadingScreen('調査の内容を読みこんでいます…'));
      app.refresh().then(render, function (err) {
        if (handleAuthError(err)) return;
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
      if (!info) return app.go('#/map');
      if (!state.practiceDone) return app.go('#/practice');
      if (!info.unlocked) return app.go('#/map');
      var redo = route.parts[2] === 'redo';
      if (redo && !info.complete) redo = false;
      return mount(KS.screens.step(no, redo));
    }
    if (name === 'clear') {
      var n = parseInt(route.parts[1], 10);
      if (!app.stepByNo(n) || !app.stepInfo(n).complete) return app.go('#/map');
      return mount(KS.screens.clear(n));
    }
    if (name === 'done') {
      if (app.currentNode() !== 'goal') return app.go('#/map');
      var steps = app.steps();
      return mount(KS.screens.clear(steps[steps.length - 1].no));
    }
    mount(KS.screens.intro());
  }

  function handleAuthError(err) {
    var code = err && err.code;
    if (code !== 'auth' && code !== 'disabled' && code !== 'closed') return false;
    var msg = (err && err.message) || 'もう一度ログインしてください。';
    store.remove('session');
    state.session = null;
    KS.sync.reset();
    app._loginMessage = msg;
    app.go('#/login');
    return true;
  }

  // 送信の途中で「ログインし直してください」と言われたとき
  KS.bus.on('sync-blocked', function (err) {
    if (!state.session) return;
    var n = KS.sync.status().pending;
    KS.dialog({
      title: 'もう一度ログインしてください',
      body: ((err && err.message) || '') + (n > 0 ? '　まだ送られていない回答 ' + n + '件 は、この端末に残っています。ログインし直すと送信されます。' : ''),
      actions: [{ label: 'ログイン画面へ', value: 1, kind: 'primary' }]
    }).then(function () { handleAuthError(err); });
  });

  window.addEventListener('hashchange', render);
  window.addEventListener('beforeunload', function (e) {
    if (current && current.guard && current.guard()) { e.preventDefault(); e.returnValue = ''; return ''; }
    return undefined;
  });

  /* ---------- はじまり ---------- */
  function start() {
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
