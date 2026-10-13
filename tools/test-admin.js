#!/usr/bin/env node
/*
 * 開発用：管理画面のための、Google 側プログラム（gas/Code.gs）の動作テスト。
 *   node tools/test-admin.js [gas/Code.gs]
 *
 * 画面（ブラウザ）を通したテストは tools/e2e-admin.js にあります。
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { createGasWorld } = require('./mock-gas');
const seed = require('./seed-admin');
const { adminBlock, embed } = require('./build-gas');

const root = path.resolve(__dirname, '..');
const code = path.resolve(process.argv[2] || path.join(root, 'gas', 'Code.gs'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  NG  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
}

// 時計：2026-10-12 14:00（日本時間）。Code.gs の中の Date.now() も同じ時計になる
let clock = Date.UTC(2026, 9, 12, 5, 0, 0);
const realNow = Date.now;
Date.now = () => clock;
const DAY = 86400000;

const w = createGasWorld(code);
w.setNow(() => clock);
const src = fs.readFileSync(code, 'utf8');
const sheet = name => w.ss.getSheetByName(name);
const setting = key => (w.sheetRows('設定').find(r => r[0] === key) || [])[1];
const col = name => w.sheetRows('回答')[0].indexOf(name);
let adminToken = '';
// 管理画面からの呼び出しと同じ形で呼ぶ
const admin = (action, payload, token) => {
  const text = w.call('ksAdminCall', token === undefined ? adminToken : token, action, payload === undefined ? undefined : JSON.stringify(payload));
  assert.strictEqual(typeof text, 'string', '返すのは JSON の文字でなければならない');
  return JSON.parse(text);
};
const openAsWeb = (email, query) => w.asVisitor(email, () => w.call('doGet', { parameter: query || { admin: '1' } }));

console.log('開き方と、開ける人');
test('初期設定の前は、だれにも管理画面を出さない', () => {
  const out = openAsWeb(w.OWNER);
  assert.strictEqual(out._html, undefined);
  assert.ok(/初期設定/.test(out.getContent()));
  assert.strictEqual(admin('overview', {}, 'adm1.9999999999.x').error, 'not_ready');
  w.call('menuOpenAdmin');
  assert.strictEqual(w.ui._lastDialog, undefined, '初期設定の前に窓を開いた');
  assert.ok(/初期設定/.test(String(w.uiLog[w.uiLog.length - 1][1])));
});

w.call('setup');
const made = seed(w, { now: clock });
const people = made.people;
adminToken = w.call('ksMakeAdminToken_');

test('ログインしていない人・ほかの人には、文字だけを返す（画面も、印も渡さない）', () => {
  for (const email of ['', 'someone@example.com', 'owner@example.com.evil.example']) {
    const out = openAsWeb(email);
    assert.strictEqual(out._html, undefined, email + ' に画面を返した');
    assert.strictEqual(out._mime, 'text/plain');
    const text = out.getContent();
    assert.ok(/開けませんでした/.test(text));
    assert.ok(!/adm1\./.test(text) && !/<script/i.test(text), '文字の返事に、印やプログラムが入っている');
  }
});
let page = '';
test('持ち主が ?admin=1 で開くと、管理画面が出る', () => {
  const out = openAsWeb(w.OWNER);
  assert.ok(out._html, '画面が返らない');
  assert.strictEqual(out._title, '方言調査 管理画面');
  assert.deepStrictEqual(out._meta, [['viewport', 'width=device-width, initial-scale=1']]);
  page = out._html;
  assert.ok(page.indexOf('__KS_BOOT__') < 0, 'はじめの情報が入っていない');
  const m = /var KS_BOOT = (\{[^\n]*?\});<\/script>/.exec(page);
  assert.ok(m, 'はじめの情報が見つからない');
  const boot = JSON.parse(m[1]);
  assert.strictEqual(boot.mode, 'web'); assert.strictEqual(boot.version, '0.4.0'); assert.strictEqual(boot.hours, 12);
  assert.strictEqual(admin('overview', {}, boot.token).ok, true);
  assert.ok(openAsWeb('OWNER@Example.com')._html, 'メールアドレスの大文字・小文字のちがいで開けない');
  assert.ok(openAsWeb(w.OWNER, { admin: '' })._html, '?admin だけでも開ける');
});
test('?admin を付けないときは、これまでどおり動作確認の返事をする', () => {
  const r = JSON.parse(openAsWeb('', {}).getContent());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ready, true); assert.strictEqual(r.version, '0.4.0');
  assert.ok(!/adm1\./.test(JSON.stringify(r)));
});
test('メニューから開くと、大きな窓で管理画面が出る', () => {
  w.call('menuOpenAdmin');
  const d = w.ui._lastDialog;
  assert.ok(d && d._html, '窓が開かない');
  assert.ok(d._width >= 900 && d._height >= 500);
  const boot = JSON.parse(/var KS_BOOT = (\{[^\n]*?\});<\/script>/.exec(d._html)[1]);
  assert.strictEqual(boot.mode, 'dialog');
  assert.strictEqual(admin('overview', {}, boot.token).ok, true);
});
test('管理画面は、外のプログラムや部品を読みこまない', () => {
  const html = fs.readFileSync(path.join(root, 'gas', 'admin.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html), '外のプログラムを読みこんでいる');
  assert.ok(!/<link\b/i.test(html) && !/@import/i.test(html), '外のスタイルを読みこんでいる');
  assert.ok(!/<(img|iframe|object|embed|form)\b/i.test(html), '外のものを表示する部品がある');
  assert.ok(!/url\(\s*["']?https?:/i.test(html), 'スタイルの中で外のものを読みこんでいる');
  assert.ok(!/\b(eval|document\.write)\s*\(/.test(html) && !/new Function/.test(html));
  assert.ok(/<base target="_blank">/.test(html));
});
test('Code.gs の中の管理画面は、gas/admin.html と同じ（入れ忘れがない）', () => {
  const pub = fs.readFileSync(path.join(root, 'gas', 'Code.gs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'gas', 'admin.html'), 'utf8');
  assert.strictEqual(embed(pub, html), pub, 'node tools/build-gas.js を実行してください');
  assert.ok(src.indexOf(adminBlock(html)) >= 0, 'テスト中のプログラムに入っている管理画面が古い');
  assert.strictEqual(page.replace(/var KS_BOOT = \{[^\n]*?\};/, 'var KS_BOOT = "__KS_BOOT__";'), html.replace(/\r\n?/g, '\n'));
});
test('外から呼べる関数は、決めたものだけ', () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(src, box);
  const names = Object.keys(box).filter(k => typeof box[k] === 'function' && !/_$/.test(k)).sort();
  assert.deepStrictEqual(names, ['addParticipants', 'doGet', 'doPost', 'ksAdminCall', 'menuAddParticipants', 'menuOpenAdmin', 'menuOpenAudioFolder',
    'menuRefreshProgress', 'menuSetup', 'onOpen', 'refreshProgress', 'setup']);
});

console.log('管理用の印（トークン）');
test('印がない・にせもの・参加者の印では、何もできない', () => {
  const login = w.post({ action: 'login', id: people[0].id, password: people[0].pw });
  const parts = adminToken.split('.');
  const bad = ['', 'x', 'adm1.' + parts[1], adminToken + 'x', adminToken.slice(0, -2) + 'AA', 'adm1.' + (Number(parts[1]) + 1) + '.' + parts[2],
    'adm2.' + parts[1] + '.' + parts[2], login.token, null, 12345];
  for (const t of bad) {
    for (const action of ['overview', 'answers', 'audio', 'passwords', 'addParticipants', 'setParticipant', 'saveSettings']) {
      const r = admin(action, { count: 1, id: 'K001', status: '停止', values: { '受付': '停止中' } }, t);
      assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'admin_auth', action + ' が ' + String(t).slice(0, 12) + ' で通った');
      assert.deepStrictEqual(Object.keys(r).sort(), ['error', 'message', 'ok']);
    }
  }
  assert.strictEqual(setting('受付'), '受付中');
  assert.strictEqual(w.sheetRows('参加者').length, 1 + people.length);
});
test('印は12時間で切れる', () => {
  const keep = clock;
  clock += 12 * 3600000 - 5000;
  assert.strictEqual(admin('passwords').ok, true);
  clock += 10000;
  assert.strictEqual(admin('passwords').error, 'admin_auth');
  clock = keep;
});
test('参加者の入口（doPost）からは、管理の操作はできない', () => {
  for (const action of ['overview', 'answers', 'passwords', 'saveSettings', 'ksAdminCall']) {
    const r = w.post({ action, token: adminToken, values: { '受付': '停止中' } });
    assert.strictEqual(r.error, 'bad_request');
  }
  assert.strictEqual(w.post({ action: 'bootstrap', token: adminToken }).error, 'auth', '管理用の印で、参加者としては入れない');
});
test('知らない操作・読めない内容はことわる', () => {
  assert.strictEqual(admin('deleteEverything').error, 'bad_request');
  assert.strictEqual(admin('').error, 'bad_request');
  assert.strictEqual(JSON.parse(w.call('ksAdminCall', adminToken, 'overview', '{こわれた')).error, 'bad_request');
  assert.strictEqual(JSON.parse(w.call('ksAdminCall', adminToken, 'overview', 'null')).ok, true);
  assert.strictEqual(JSON.parse(w.call('ksAdminCall', adminToken, 'overview')).ok, true);
});

console.log('全体のようす');
const items = w.call('ksReadItems_');
let ov;
test('人数・回答数・進み具合が、表の中身と合っている', () => {
  ov = admin('overview');
  assert.strictEqual(ov.ok, true, JSON.stringify(ov).slice(0, 300));
  const rows = w.sheetRows('回答').slice(1);
  assert.strictEqual(ov.totals.participants, 8);
  assert.strictEqual(ov.totals.rows, rows.length);
  assert.strictEqual(ov.totals.rows, made.rows);
  assert.strictEqual(ov.totals.started, 6);
  assert.strictEqual(ov.totals.finished, 2);
  assert.strictEqual(ov.items.length, items.length);
  assert.strictEqual(ov.steps.reduce((n, s) => n + s.count, 0), items.length);
  assert.strictEqual(ov.today, '2026-10-12');
  assert.strictEqual(ov.at, clock);
  const today = rows.filter(r => r[0].getTime() >= Date.UTC(2026, 9, 11, 15)).length;
  assert.strictEqual(ov.totals.today, today);
  assert.strictEqual(ov.daily.reduce((n, d) => n + d[1], 0), rows.length);
  assert.ok(ov.daily.every((d, i) => /^\d{4}-\d{2}-\d{2}$/.test(d[0]) && (i === 0 || ov.daily[i - 1][0] < d[0])), '日ごとの数が日付の順でない');
  const p1 = ov.participants.find(p => p.id === people[0].id);
  assert.strictEqual(p1.answered, items.length); assert.strictEqual(p1.rows, items.length); assert.strictEqual(p1.registered, true);
  assert.deepStrictEqual(Array.from(p1.stepsDone), ov.steps.map(s => s.count));
  assert.ok(p1.firstAt > 0 && p1.lastAt >= p1.firstAt && p1.lastLoginAt > 0 && p1.registeredAt > 0);
  const p8 = ov.participants.find(p => p.id === people[7].id);
  assert.strictEqual(p8.disabled, true); assert.strictEqual(p8.memo, '10/20 に登録の予定'); assert.strictEqual(p8.rows, 0); assert.strictEqual(p8.lastAt, 0);
  assert.deepStrictEqual(Array.from(ov.stepCleared), ov.steps.map((s, i) => ov.participants.filter(p => p.stepsDone[i] >= s.count).length));
  for (const it of ov.items) {
    const n = ov.participants.filter(p => rows.some(r => r[1] === p.id && r[3] === it.id)).length;
    assert.strictEqual(it.stat.reduce((a, b) => a + b, 0), n, it.id + ' の内訳の合計');
  }
  assert.strictEqual(ov.totals.audioFiles, w.files().length);
  assert.strictEqual(ov.totals.noAudio, rows.filter(r => r[6] === '回答済' && !r[13]).length);
  assert.strictEqual(ov.totals.noisy, rows.filter(r => typeof r[24] === 'number' && r[24] < 20).length);
  assert.ok(ov.totals.noisy > 0 && ov.totals.noAudio > 0, 'テストの見本に、雑音の多い録音・録音なしの回答がない');
  assert.deepStrictEqual(Array.from(ov.statuses), ['回答済', '知らない', '使わない', '思い出せない']);
  assert.deepStrictEqual(Array.from(ov.problems), []);
});
test('直近の回答は新しい順に8件。日時は数字（ミリ秒）で渡す', () => {
  assert.strictEqual(ov.recent.length, 8);
  for (let i = 1; i < ov.recent.length; i++) assert.ok(ov.recent[i - 1].at >= ov.recent[i].at);
  const newest = Math.max.apply(null, w.sheetRows('回答').slice(1).map(r => r[0].getTime()));
  assert.strictEqual(ov.recent[0].at, newest);
  const text = w.call('ksAdminCall', adminToken, 'overview', '{}');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(text.replace(/"clientTime":"[^"]*"/g, '')), '日付がそのまま入っている');
});
test('設定・リンクを渡す。パスワードは「全体のようす」には入れない', () => {
  assert.deepStrictEqual(ov.settings, { open: true, notice: '', instruction: setting('教示文'), wordQuestion: '「{語}」のことをなんといいますか？', sentenceQuestion: '「{文}」をなんといいますか？',
    maxRecordSec: 20, noiseWarnDb: 20, idPrefix: 'K', siteUrl: '' });
  assert.ok(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(ov.links.spreadsheet));
  for (const n of ['設定', '参加者', '歩', '項目', '回答']) assert.ok(new RegExp('#gid=' + sheet(n).getSheetId() + '$').test(ov.links.sheets[n]), n);
  assert.ok(/^https:\/\/drive\.google\.com\/drive\/folders\//.test(ov.links.audioFolder));
  const text = JSON.stringify(ov);
  for (const p of people) assert.ok(text.indexOf(p.pw) < 0, 'パスワードが入っている');
  assert.ok(text.indexOf(w.props.TOKEN_SECRET) < 0);
});
test('同じ設問に答え直した人は、いちばん新しい回答で数える', () => {
  const p = people[5];                                   // 少しだけ答えた人
  const before = admin('overview');
  const it = before.items[0];
  const login = w.post({ action: 'login', id: p.id, password: p.pw });
  const res = w.post({ action: 'save', token: login.token, submission: { submissionId: 'redo-000001', itemId: it.id, step: it.step, type: it.type, prompt: it.prompt, status: '知らない', audio: [] } });
  assert.strictEqual(res.saved, true);
  const after = admin('overview');
  const a = after.participants.find(x => x.id === p.id), b = before.participants.find(x => x.id === p.id);
  assert.strictEqual(a.rows, b.rows + 1); assert.strictEqual(a.answered, b.answered); assert.strictEqual(a.noAnswer, b.noAnswer + 1);
  const s0 = before.items[0].stat, s1 = after.items[0].stat;
  assert.strictEqual(s1[0], s0[0] - 1); assert.strictEqual(s1[1], s0[1] + 1);
  assert.strictEqual(after.recent[0].sid, 'redo-000001'); assert.strictEqual(after.recent[0].status, '知らない');
});
test('「参加者」シートにない人の回答・いまは出していない設問の回答も、こわれずに数える', () => {
  const sh = sheet('回答');
  const head = w.sheetRows('回答')[0];
  const row = head.map(() => '');
  row[col('送信日時')] = new Date(clock - 3 * DAY); row[col('参加者ナンバー')] = 'Z999'; row[col('設問ID')] = items[0].id; row[col('回答の状態')] = '回答済';
  row[col('回答（地域の言葉）')] = 'むかしの回答'; row[col('送信ID')] = 'ghost-000001';
  sh.appendRow(row);
  const row2 = row.slice(); row2[col('設問ID')] = 'OLD-1'; row2[col('送信ID')] = 'ghost-000002'; row2[col('参加者ナンバー')] = people[6].id; row2[col('回答（地域の言葉）')] = 'いまは出していない設問';
  sh.appendRow(row2);
  const o = admin('overview');
  const ghost = o.participants.find(p => p.id === 'Z999');
  assert.ok(ghost && ghost.registered === false && ghost.answered === 1 && ghost.rows === 1);
  const p7 = o.participants.find(p => p.id === people[6].id);
  assert.strictEqual(p7.rows, 1); assert.strictEqual(p7.answered, 0, '出していない設問を、進み具合に数えている');
  assert.strictEqual(o.totals.participants, 9); assert.strictEqual(o.totals.started, 8);
});
test('日本時間で日を数える（夜中の0時をまたぐ回答）', () => {
  const sh = sheet('回答');
  const head = w.sheetRows('回答')[0];
  const mk = (ms, sid) => { const r = head.map(() => ''); r[col('送信日時')] = new Date(ms); r[col('参加者ナンバー')] = 'Z999'; r[col('設問ID')] = items[1].id; r[col('回答の状態')] = '回答済'; r[col('送信ID')] = sid; return r; };
  sh.appendRow(mk(Date.UTC(2026, 8, 30, 14, 59, 59), 'night-00001'));     // 日本時間 9/30 23:59:59
  sh.appendRow(mk(Date.UTC(2026, 8, 30, 15, 0, 0), 'night-00002'));       // 日本時間 10/1 0:00:00
  const o = admin('overview');
  const day = d => (o.daily.find(x => x[0] === d) || [d, 0])[1];
  const base = ov.daily.reduce((m, d) => { m[d[0]] = d[1]; return m; }, {});
  assert.strictEqual(day('2026-09-30'), (base['2026-09-30'] || 0) + 1);
  assert.strictEqual(day('2026-10-01'), (base['2026-10-01'] || 0) + 1);
});
test('表や録音フォルダに問題があるときは、知らせる文を返す', () => {
  const sh = sheet('回答');
  const keep = sh.rows[0][col('送信ID')];
  sh.rows[0][col('送信ID')] = 'ID';
  let o = admin('overview');
  assert.strictEqual(o.ok, true); assert.ok(o.problems.some(p => /見出し/.test(p)));
  assert.strictEqual(admin('answers').error, 'server_error');
  sh.rows[0][22] = keep;
  const folder = w.driveItems[w.props.AUDIO_FOLDER_ID];
  folder.setTrashed(true);
  o = admin('overview');
  assert.ok(o.problems.some(p => /録音フォルダ/.test(p))); assert.strictEqual(o.links.audioFolder, '');
  folder.setTrashed(false);
  assert.deepStrictEqual(Array.from(admin('overview').problems), []);
});

console.log('回答の一覧');
const allRows = () => w.sheetRows('回答').slice(1);
test('新しい順に、50件ずつ渡す', () => {
  const r = admin('answers', {});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.total, allRows().length); assert.strictEqual(r.limit, 50); assert.strictEqual(r.offset, 0);
  assert.strictEqual(r.rows.length, Math.min(50, r.total));
  for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].at >= r.rows[i].at);
  const x = r.rows[0];
  const sheetRow = w.sheetRows('回答')[x.n - 1];
  assert.strictEqual(sheetRow[col('送信ID')], x.sid, '行番号が合っていない');
  assert.strictEqual(sheetRow[0].getTime(), x.at);
});
test('ページを送れる。行数の上限は200。範囲の外を頼まれたら、最後のページを返す', () => {
  const total = allRows().length;
  const a = admin('answers', { offset: 0, limit: 10 }), b = admin('answers', { offset: 10, limit: 10 });
  assert.strictEqual(a.rows.length, 10); assert.strictEqual(b.offset, 10);
  assert.ok(!a.rows.some(x => b.rows.some(y => y.sid === x.sid)), 'ページが重なっている');
  assert.strictEqual(admin('answers', { limit: 9999 }).limit, 200);
  assert.strictEqual(admin('answers', { limit: -5 }).limit, 50);
  const last = admin('answers', { offset: 100000, limit: 10 });
  assert.strictEqual(last.offset, Math.floor((total - 1) / 10) * 10); assert.ok(last.rows.length >= 1);
  assert.strictEqual(admin('answers', { offset: 'abc' }).offset, 0);
});
test('参加者・歩・設問・状態・録音の注意・文字でしぼりこめる', () => {
  const rows = allRows();
  const by = f => admin('answers', { filter: f, limit: 200 });
  const pid = people[2].id;
  let r = by({ participant: pid });
  assert.strictEqual(r.total, rows.filter(x => x[1] === pid).length); assert.ok(r.rows.every(x => x.pid === pid));
  assert.strictEqual(by({ participant: ' ' + pid.toLowerCase() + ' ' }).total, r.total, '小文字や空白まじりでも同じ');
  const step = items[items.length - 1].step;
  r = by({ step: String(step) });
  assert.strictEqual(r.total, rows.filter(x => x[2] === step).length); assert.ok(r.rows.every(x => x.step === step));
  r = by({ item: items[1].id });
  assert.strictEqual(r.total, rows.filter(x => x[3] === items[1].id).length);
  r = by({ status: '知らない' });
  assert.strictEqual(r.total, rows.filter(x => x[6] === '知らない').length); assert.ok(r.total > 0);
  assert.strictEqual(by({ status: 'うそ' }).total, rows.length, '知らない状態の名前は、しぼりこみなしとして扱う');
  r = by({ flag: 'noisy' });
  assert.strictEqual(r.total, rows.filter(x => typeof x[24] === 'number' && x[24] < 20).length); assert.ok(r.rows.every(x => x.snr < 20));
  r = by({ flag: 'noaudio' });
  assert.strictEqual(r.total, rows.filter(x => x[6] === '回答済' && !x[13]).length); assert.ok(r.rows.every(x => !x.a1 && x.status === '回答済'));
  r = by({ participant: people[3].id, flag: 'noisy' });
  assert.ok(r.total > 0 && r.rows.every(x => x.pid === people[3].id && x.snr < 20));
  r = by({ q: 'むかしの' });
  assert.strictEqual(r.total, 1); assert.strictEqual(r.rows[0].pid, 'Z999');
  assert.strictEqual(by({ q: 'ＳＥＥＤ' }).total, 0, '送信IDは、さがす対象にしない');
  assert.strictEqual(by({ q: people[1].id.toLowerCase() }).total, rows.filter(x => x[1] === people[1].id).length, 'ナンバーでもさがせる（小文字でも）');
  assert.strictEqual(by({ q: 'どこにもない文字' }).total, 0);
});
test('さがす文字は、全角と半角・大文字と小文字を区別しない（表の中の文字も、そろえてからくらべる）', () => {
  const sh = sheet('回答');
  const x = admin('answers', { limit: 200 }).rows.find(y => y.status === '回答済');
  const keep = sh.rows[x.n - 1][col('回答（地域の言葉）')];
  sh.rows[x.n - 1][col('回答（地域の言葉）')] = 'ＡＢＣ１２３　ﾊﾝｶｸ';
  const by = q => admin('answers', { filter: { q } });
  assert.strictEqual(by('abc123').total, 1, '全角で書かれた回答を、半角でさがせない');
  assert.strictEqual(by('Ａｂｃ１２３').total, 1);
  assert.strictEqual(by('ハンカク').total, 1, '半角カナで書かれた回答を、全角でさがせない');
  assert.strictEqual(by('abc123').rows[0].answer, 'ＡＢＣ１２３　ﾊﾝｶｸ', '渡す文字は、表に書いてあるとおり');
  assert.strictEqual(by(x.pid + x.item).total, 0, '列をまたいだ文字のつながりに当たった');
  sh.rows[x.n - 1][col('回答（地域の言葉）')] = keep;
});
test('しぼりこむ前の件数（all）も渡す。「全体のようす」の回答数と同じ', () => {
  const all = admin('answers', {}).total;
  for (const f of [{}, { q: 'どこにもない文字' }, { participant: people[0].id }, { flag: 'noisy' }]) assert.strictEqual(admin('answers', { filter: f }).all, all, JSON.stringify(f));
  assert.strictEqual(admin('answers', { filter: { q: 'どこにもない文字' } }).total, 0);
  assert.strictEqual(admin('overview').totals.rows, all);
});
test('1行の中身：録音のリンク・雑音の数値・技術情報', () => {
  const r = admin('answers', { filter: { participant: people[0].id }, limit: 200 });
  const x = r.rows.find(y => y.a1 && y.type === '例文');
  assert.ok(/^https:\/\/drive\.google\.com\/file\/d\//.test(x.a1.url)); assert.ok(/\.wav$/.test(x.a1.name));
  assert.strictEqual(typeof x.snr, 'number'); assert.strictEqual(typeof x.sec, 'number'); assert.strictEqual(x.hz, 16000);
  assert.strictEqual(x.info.main.ec, false); assert.strictEqual(typeof x.info.main.noise, 'number');
  assert.ok(x.segP.indexOf('｜') > 0 && x.segA.indexOf('｜') > 0);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(x.clientTime));
  const word = r.rows.find(y => y.type === '語彙' && y.a2);
  if (word) assert.ok(/reibun/.test(word.a2.name));
  assert.strictEqual(r.noiseTh, 20);
});
test('回答の中の記号やタグは、そのままの文字として渡す（数式にもならない）', () => {
  const p = people[5];
  const login = w.post({ action: 'login', id: p.id, password: p.pw });
  const evil = '<img src=x onerror="window.__xss=1">';
  const res = w.post({ action: 'save', token: login.token, submission: { submissionId: 'evil-000001', itemId: items[2].id, step: items[2].step, type: items[2].type,
    prompt: '=HYPERLINK("http://example.com")', status: '回答済', answer: evil, note: '=1+1', exampleAnswer: '"><script>window.__xss=1</script>', device: evil, noAudioReason: 'マイクが使えない', audio: [] } });
  assert.strictEqual(res.saved, true);
  const x = admin('answers', { filter: { q: 'onerror' } }).rows[0];
  assert.strictEqual(x.answer, evil); assert.strictEqual(x.note, '=1+1'); assert.strictEqual(x.prompt, '=HYPERLINK("http://example.com")');
  assert.strictEqual(x.device, evil); assert.strictEqual(x.a1, null);
  assert.strictEqual(w.ss.sheets.reduce((n, s) => n + s.formulas.length, 0), 0, '数式として書きこまれた');
});
test('リンクの列に https 以外のものが書いてあっても、リンクとしては渡さない', () => {
  const sh = sheet('回答');
  const n = sh.getLastRow();
  sh.rows[n - 1][col('録音1')] = 'x.wav'; sh.rows[n - 1][col('録音1リンク')] = 'javascript:alert(1)';
  let x = admin('answers', { filter: { q: 'onerror' } }).rows[0];
  assert.strictEqual(x.a1, null);
  sh.rows[n - 1][col('録音1リンク')] = 'https://example.com/"onmouseover="x';
  x = admin('answers', { filter: { q: 'onerror' } }).rows[0];
  assert.strictEqual(x.a1, null);
  sh.rows[n - 1][col('録音1')] = ''; sh.rows[n - 1][col('録音1リンク')] = '';
});

console.log('録音を聞く');
test('回答の録音を、そのままの中身で取り出せる（回答の録音・例文の録音）', () => {
  const rows = admin('answers', { filter: { participant: people[0].id }, limit: 200 }).rows;
  const x = rows.find(y => y.a1);
  const a = admin('audio', { sid: x.sid, slot: 'main' });
  assert.strictEqual(a.ok, true, JSON.stringify(a).slice(0, 200));
  assert.strictEqual(a.name, x.a1.name);
  const id = /\/d\/([^/]+)/.exec(x.a1.url)[1];
  assert.ok(Buffer.from(a.b64, 'base64').equals(w.fileBytes(id)), '中身がちがう');
  assert.strictEqual(a.bytes, w.fileBytes(id).length);
  const two = rows.find(y => y.a2);
  if (two) {
    const b = admin('audio', { sid: two.sid, slot: 'example' });
    assert.strictEqual(b.name, two.a2.name); assert.ok(Buffer.from(b.b64, 'base64').equals(w.fileBytes(/\/d\/([^/]+)/.exec(two.a2.url)[1])));
  }
});
test('録音のない回答・知らない送信ID・ごみ箱の中のファイル・大きすぎるファイル', () => {
  const rows = admin('answers', { limit: 200 }).rows;
  const none = rows.find(y => !y.a1);
  assert.strictEqual(admin('audio', { sid: none.sid, slot: 'main' }).error, 'not_found');
  assert.strictEqual(admin('audio', { sid: 'nothere-0001', slot: 'main' }).error, 'not_found');
  for (const sid of ['', 'a', '../../x', 'a b c d e f g h', { $ne: 1 }]) assert.strictEqual(admin('audio', { sid, slot: 'main' }).error, 'bad_request');
  const x = rows.find(y => y.a1 && !y.a2);
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'example' }).error, 'not_found');
  const file = w.driveItems[/\/d\/([^/]+)/.exec(x.a1.url)[1]];
  file.setTrashed(true);
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).error, 'not_found');
  file.setTrashed(false);
  const keep = file.bytes;
  file.bytes = Buffer.alloc(8388609);
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).error, 'too_large');
  file.bytes = keep;
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).ok, true);
});
test('リンクの列がドライブのファイルでないときは、取り出さない', () => {
  const sh = sheet('回答');
  const rows = admin('answers', { limit: 200 }).rows;
  const x = rows.find(y => y.a1);
  const keep = sh.rows[x.n - 1][col('録音1リンク')];
  for (const url of ['https://example.com/a.wav', 'https://drive.google.com/file/d/' + w.ss.getId().replace(/[^A-Za-z0-9_-]/g, '') + 'zz/view', 'file:///etc/passwd']) {
    sh.rows[x.n - 1][col('録音1リンク')] = url;
    assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).error, 'not_found', url);
  }
  sh.rows[x.n - 1][col('録音1リンク')] = keep;
});

test('リンクの先が録音でないファイルのときは、取り出さない', () => {
  const x = admin('answers', { limit: 200 }).rows.find(y => y.a1);
  const file = w.driveItems[/\/d\/([^/]+)/.exec(x.a1.url)[1]];
  const keep = { mime: file.mime, name: file.name };
  file.mime = 'text/plain'; file.name = 'memo.txt';
  const r = admin('audio', { sid: x.sid, slot: 'main' });
  assert.strictEqual(r.error, 'not_found'); assert.ok(/録音のファイルではありません/.test(r.message));
  assert.strictEqual(r.b64, undefined);
  file.mime = 'application/vnd.google-apps.spreadsheet'; file.name = '方言調査データ';
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).error, 'not_found');
  // 種類の書き方がちがっても、録音なら渡す
  file.mime = 'audio/x-wav'; file.name = 'rokuon';
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).ok, true);
  file.mime = 'application/octet-stream'; file.name = 'ROKUON.WAV';
  assert.strictEqual(admin('audio', { sid: x.sid, slot: 'main' }).ok, true);
  file.mime = keep.mime; file.name = keep.name;
});

console.log('参加者');
test('パスワードの一覧は、頼まれたときだけ渡す', () => {
  const r = admin('passwords');
  assert.deepStrictEqual(r.list.map(x => x.id), people.map(p => p.id));
  assert.deepStrictEqual(r.list.map(x => x.password), people.map(p => p.pw));
});
test('参加者を追加できる（1〜50人）。作ったナンバーとパスワードを返す', () => {
  const before = w.sheetRows('参加者').length;
  const r = admin('addParticipants', { count: 3 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.added.map(x => x.id), ['K009', 'K010', 'K011']);
  for (const x of r.added) assert.ok(/^\d{6}$/.test(x.password));
  const rows = w.sheetRows('参加者');
  assert.strictEqual(rows.length, before + 3);
  assert.strictEqual(rows[rows.length - 1][0], 'K011'); assert.strictEqual(rows[rows.length - 1][1], r.added[2].password); assert.strictEqual(rows[rows.length - 1][2], '有効');
  assert.strictEqual(w.post({ action: 'login', id: 'K011', password: r.added[2].password }).ok, true, '作った参加者でログインできる');
  assert.strictEqual(admin('addParticipants', { count: '２' }).added.length, 2, '全角の数字でも受けつける');
  for (const count of [0, 51, -1, 'abc', '', null, '0', 2.5, '2.5', '1e1', '0x10', '5人', '100', [3], { n: 3 }]) assert.strictEqual(admin('addParticipants', { count }).error, 'invalid', JSON.stringify(count));
  assert.strictEqual(w.sheetRows('参加者').length, before + 5);
  w.control.lockBusy = 1;
  assert.strictEqual(admin('addParticipants', { count: 1 }).error, 'busy');
  assert.strictEqual(w.sheetRows('参加者').length, before + 5);
});
test('参加者を停止すると、すぐに送信できなくなる。元にもどせる', () => {
  const p = people[2];
  const login = w.post({ action: 'login', id: p.id, password: p.pw });
  assert.strictEqual(w.post({ action: 'bootstrap', token: login.token }).ok, true);        // ここで「使える」と覚える
  const r = admin('setParticipant', { id: p.id.toLowerCase(), status: '停止' });
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.participant, { id: p.id, disabled: true, memo: '' });
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[2], '停止');
  assert.strictEqual(w.post({ action: 'bootstrap', token: login.token }).error, 'disabled', '停止したのに、まだ使える');
  assert.strictEqual(w.post({ action: 'login', id: p.id, password: p.pw }).error, 'disabled');
  assert.strictEqual(admin('overview').participants.find(x => x.id === p.id).disabled, true);
  assert.strictEqual(admin('setParticipant', { id: p.id, status: '有効' }).participant.disabled, false);
  assert.strictEqual(w.post({ action: 'bootstrap', token: login.token }).ok, true);
});
test('メモを書ける（改行は空白に、数式にはしない）。長すぎるメモは、切らずにことわる', () => {
  const p = people[1];
  let r = admin('setParticipant', { id: p.id, memo: '70代・\n鹿児島市' });
  assert.strictEqual(r.participant.memo, '70代・ 鹿児島市');
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[3], '70代・ 鹿児島市');
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[2], '有効', 'メモだけを変えたのに、状態が変わった');
  r = admin('setParticipant', { id: p.id, memo: '=IMPORTXML("http://example.com")' });
  assert.strictEqual(r.participant.memo, '=IMPORTXML("http://example.com")');
  assert.strictEqual(w.ss.sheets.reduce((n, s) => n + s.formulas.length, 0), 0);
  r = admin('setParticipant', { id: p.id, memo: 'あ'.repeat(500) });
  assert.strictEqual(r.participant.memo.length, 500);
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[3].length, 500);
  r = admin('setParticipant', { id: p.id, memo: 'い'.repeat(501) });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/500 文字まで/.test(r.message) && /501 文字/.test(r.message), r.message);
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[3], 'あ'.repeat(500), 'ことわったのに、書きかえた');
  // 状態といっしょに送られた長すぎるメモ：どちらも書かない
  r = admin('setParticipant', { id: p.id, status: '停止', memo: 'い'.repeat(501) });
  assert.strictEqual(r.error, 'invalid');
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[2], '有効', 'メモをことわったのに、状態だけ変えた');
  r = admin('setParticipant', { id: p.id, memo: '10/20' });
  assert.strictEqual(w.sheetRows('参加者').find(x => x[0] === p.id)[3], '10/20');
  assert.strictEqual(admin('setParticipant', { id: p.id, memo: '' }).participant.memo, '');
  assert.strictEqual(admin('overview').participants.find(x => x.id === p.id).memo, '');
});
test('スプレッドシートに直接書いたメモが日付に変わっていても、読める形で渡す', () => {
  const sh = sheet('参加者');
  const i = sh.rows.findIndex(x => x[0] === people[1].id);
  sh.rows[i][3] = new Date(Date.UTC(2026, 9, 19, 15, 0, 0));       // 表が「10/20」を日付に直したもの（日本時間の 10/20 0:00）
  assert.strictEqual(admin('overview').participants.find(x => x.id === people[1].id).memo, '2026/10/20');
  sh.rows[i][3] = 20;
  assert.strictEqual(admin('overview').participants.find(x => x.id === people[1].id).memo, '20');
  sh.rows[i][3] = '';
});
test('知らないナンバー・決まっていない状態はことわる', () => {
  assert.strictEqual(admin('setParticipant', { id: 'NOPE', status: '停止' }).error, 'not_found');
  assert.strictEqual(admin('setParticipant', { status: '停止' }).error, 'bad_request');
  assert.strictEqual(admin('setParticipant', { id: people[0].id, status: '削除' }).error, 'invalid');
  assert.strictEqual(admin('setParticipant', { id: 'Z999', memo: 'x' }).error, 'not_found', '「参加者」シートにない人は変えられない');
});

console.log('「参加者」シートの列を足したり、並べかえたりしたとき');
{
  // べつの表で確かめる（ほかのテストの表を、こわさないように）
  const quietLog = console.log; console.log = () => {};
  const w2 = createGasWorld(code);
  w2.setNow(() => clock);
  w2.call('setup');
  w2.call('addParticipants', 3);
  console.log = quietLog;
  const token2 = w2.call('ksMakeAdminToken_');
  const admin2 = (action, payload) => JSON.parse(w2.call('ksAdminCall', token2, action, JSON.stringify(payload || {})));
  const ps = () => w2.ss.getSheetByName('参加者');
  const colOf = name => ps().rows[0].indexOf(name);
  const cell = (id, name) => { const r = ps().rows.find(x => x[colOf('参加者ナンバー')] === id); const v = r ? r[colOf(name)] : undefined; return v === undefined ? '' : v; };
  // 列を1つ、at 番目に差しこむ（見出しと、各行の値）
  const insertCol = (at, head, value) => ps().rows.forEach((r, i) => { while (r.length < at) r.push(''); r.splice(at, 0, i === 0 ? head : value(i)); });
  const first = ps().rows.slice(1).map(r => ({ id: r[0], pw: r[1] }));

  test('列を足しても（左はし・とちゅう）、ログイン・停止・メモ・追加が、見出しの名前の列で動く', () => {
    insertCol(0, '氏名', i => 'なまえ' + i);                 // いちばん左に
    insertCol(3, '年代', i => (i + 5) + '0代');             // パスワードと状態のあいだに
    assert.deepStrictEqual(ps().rows[0], ['氏名', '参加者ナンバー', 'パスワード', '年代', '状態', 'メモ', '登録日', '最終ログイン']);
    const extra = () => JSON.stringify(ps().rows.slice(0, 4).map(r => [r[colOf('氏名')], r[colOf('年代')]]));
    const keep = extra();
    // ログイン
    const login = w2.post({ action: 'login', id: first[0].id, password: first[0].pw });
    assert.strictEqual(login.ok, true, JSON.stringify(login));
    assert.ok(cell(first[0].id, '最終ログイン') instanceof Date, '最終ログインが、見出しの列に入っていない');
    assert.strictEqual(w2.post({ action: 'login', id: first[1].id, password: 'ちがう' }).error, 'bad_credentials');
    // 管理画面
    let o = admin2('overview');
    assert.deepStrictEqual(o.problems, []);
    assert.deepStrictEqual(o.participants.map(x => [x.id, x.disabled, x.memo]), first.map(x => [x.id, false, '']));
    assert.ok(o.participants[0].lastLoginAt > 0 && o.participants[0].registeredAt > 0);
    assert.deepStrictEqual(admin2('passwords').list, first.map(x => ({ id: x.id, password: x.pw })));
    assert.strictEqual(admin2('setParticipant', { id: first[1].id, memo: '70代・谷山' }).participant.memo, '70代・谷山');
    assert.strictEqual(cell(first[1].id, 'メモ'), '70代・谷山');
    assert.strictEqual(admin2('setParticipant', { id: first[2].id, status: '停止' }).participant.disabled, true);
    assert.strictEqual(cell(first[2].id, '状態'), '停止');
    assert.strictEqual(w2.post({ action: 'login', id: first[2].id, password: first[2].pw }).error, 'disabled');
    assert.strictEqual(extra(), keep, '調査者が足した列が、書きかえられた');
    // 追加
    const added = admin2('addParticipants', { count: 2 }).added;
    assert.deepStrictEqual(added.map(x => x.id), ['K004', 'K005']);
    for (const a of added) {
      assert.strictEqual(cell(a.id, 'パスワード'), a.password); assert.strictEqual(cell(a.id, '状態'), '有効');
      assert.ok(cell(a.id, '登録日') instanceof Date);
      assert.strictEqual(cell(a.id, '氏名'), ''); assert.strictEqual(cell(a.id, '年代'), ''); assert.strictEqual(cell(a.id, 'メモ'), '');
      assert.strictEqual(w2.post({ action: 'login', id: a.id, password: a.password }).ok, true, '追加した人でログインできない');
    }
    assert.strictEqual(extra(), keep);
    o = admin2('overview');
    assert.strictEqual(o.participants.length, 5); assert.strictEqual(o.participants[2].disabled, true); assert.strictEqual(o.participants[1].memo, '70代・谷山');
    // 進み具合（メニュー）も、見出しの名前で読む
    assert.strictEqual(w2.call('refreshProgress'), 5);
  });
  test('列を足したあとで初期設定をやり直しても、中身は変わらない', () => {
    const before = JSON.stringify(ps().rows);
    const quiet = console.log; console.log = () => {};
    const msg = w2.call('setup');
    console.log = quiet;
    assert.strictEqual(JSON.stringify(ps().rows), before);
    assert.ok(/すでに設定ずみ/.test(msg), msg);
    // 文字として扱う列（頭のゼロが消えない）は、ナンバーとパスワードの列
    const sh = ps();
    assert.strictEqual(sh._format(2, colOf('参加者ナンバー') + 1), '@'); assert.strictEqual(sh._format(2, colOf('パスワード') + 1), '@');
    assert.strictEqual(sh._format(2, colOf('最終ログイン') + 1), 'yyyy-mm-dd hh:mm');
  });
  test('列の順番を入れかえても、同じように動く', () => {
    // メモの列を、いちばん左へ移す
    const from = colOf('メモ');
    ps().rows.forEach(r => { while (r.length <= from) r.push(''); const v = r.splice(from, 1)[0]; r.unshift(v); });
    assert.strictEqual(ps().rows[0][0], 'メモ');
    assert.strictEqual(w2.post({ action: 'login', id: first[0].id, password: first[0].pw }).ok, true);
    const o = admin2('overview');
    assert.deepStrictEqual(o.problems, []);
    assert.strictEqual(o.participants.find(x => x.id === first[1].id).memo, '70代・谷山');
    assert.strictEqual(admin2('setParticipant', { id: first[0].id, memo: 'うつしたあとのメモ' }).ok, true);
    assert.strictEqual(ps().rows.find(r => r[colOf('参加者ナンバー')] === first[0].id)[0], 'うつしたあとのメモ');
    assert.strictEqual(admin2('setParticipant', { id: first[2].id, status: '有効' }).participant.disabled, false);
    assert.strictEqual(cell(first[2].id, '状態'), '有効');
    assert.strictEqual(admin2('addParticipants', { count: 1 }).added[0].id, 'K006');
    assert.strictEqual(cell('K006', '状態'), '有効'); assert.strictEqual(cell('K006', 'メモ'), '');
  });
  test('シートの行が足りなくなっても、行を足して追加できる', () => {
    const sh = ps();
    sh.maxRows = sh.getLastRow() + 1;
    const r = admin2('addParticipants', { count: 5 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.added.length, 5);
    assert.strictEqual(w2.post({ action: 'login', id: r.added[4].id, password: r.added[4].password }).ok, true);
  });
  test('見出しの名前を変えてしまったとき：読むのは今までどおり。書きこみは、ちがう列を上書きしないようにことわり、直し方を知らせる', () => {
    const quietLog2 = console.log; console.log = () => {};
    const w3 = createGasWorld(code);
    w3.setNow(() => clock);
    w3.call('setup');
    w3.call('addParticipants', 2);
    console.log = quietLog2;
    const t3 = w3.call('ksMakeAdminToken_');
    const admin3 = (action, payload) => JSON.parse(w3.call('ksAdminCall', t3, action, JSON.stringify(payload || {})));
    const sh = w3.ss.getSheetByName('参加者');
    const who = sh.rows.slice(1).map(r => ({ id: r[0], pw: r[1] }));
    sh.rows[1][3] = 'はじめからあるメモ';
    sh.rows[0][3] = '備考';                                  // 「メモ」→「備考」
    sh.rows[0][1] = 'PW';                                    // 「パスワード」→「PW」
    assert.strictEqual(w3.post({ action: 'login', id: who[0].id, password: who[0].pw }).ok, true, '見出しの名前を変えただけで、ログインできなくなった');
    let o = admin3('overview');
    assert.ok(o.problems.some(x => /「パスワード」「メモ」/.test(x)), o.problems.join(' / '));
    assert.strictEqual(o.participants[0].memo, 'はじめからあるメモ');
    assert.deepStrictEqual(admin3('passwords').list.map(x => x.password), who.map(x => x.pw));
    const r = admin3('setParticipant', { id: who[0].id, memo: '上書きしてはいけない' });
    assert.strictEqual(r.error, 'invalid'); assert.ok(/見出し「メモ」が見つかりません/.test(r.message), r.message);
    assert.strictEqual(sh.rows[1][3], 'はじめからあるメモ');
    assert.strictEqual(admin3('setParticipant', { id: who[1].id, status: '停止' }).participant.disabled, true, '見出しがそのままの「状態」は、変えられる');
    // 初期設定をやり直すと、「メモ」の列が右はしに足される（「備考」の列は、そのまま）。パスワードの列は、勝手には足さない
    const quiet = console.log; console.log = () => {};
    const msg = w3.call('setup');
    console.log = quiet;
    assert.ok(/「参加者」シートの列「メモ」/.test(msg), msg);
    assert.strictEqual(sh.rows[0].filter(h => h === 'パスワード').length, 0, 'パスワードの列を、勝手に足した');
    assert.strictEqual(sh.rows[0].indexOf('メモ'), 6);
    assert.strictEqual(admin3('setParticipant', { id: who[0].id, memo: '新しい列のメモ' }).ok, true);
    assert.strictEqual(sh.rows[1][6], '新しい列のメモ'); assert.strictEqual(sh.rows[1][3], 'はじめからあるメモ');
    assert.strictEqual(w3.post({ action: 'login', id: who[0].id, password: who[0].pw }).ok, true);
    o = admin3('overview');
    assert.ok(o.problems.some(x => /見出し「パスワード」が見つかりません/.test(x)), o.problems.join(' / '));
  });
}

console.log('設定');
test('受付を止めると、参加者はログインも送信もできない。再開できる', () => {
  const p = people[0];
  const login = w.post({ action: 'login', id: p.id, password: p.pw });
  let r = admin('saveSettings', { values: { '受付': '停止中' } });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.settings.open, false); assert.strictEqual(setting('受付'), '停止中');
  assert.strictEqual(w.post({ action: 'login', id: p.id, password: p.pw }).error, 'closed');
  assert.strictEqual(w.post({ action: 'bootstrap', token: login.token }).error, 'closed');
  assert.strictEqual(admin('overview').settings.open, false, '止めていても、管理画面は使える');
  r = admin('saveSettings', { values: { '受付': '受付中' } });
  assert.strictEqual(r.settings.open, true);
  assert.strictEqual(w.post({ action: 'bootstrap', token: login.token }).ok, true);
  assert.strictEqual(admin('saveSettings', { values: { '受付': 'やすみ' } }).error, 'invalid');
  assert.strictEqual(setting('受付'), '受付中');
});
test('文章・数字・頭文字・サイトのURLを保存できる。参加者の画面にも届く', () => {
  const values = { 'お知らせ': '10/20 は、お休みします。', '教示文': 'ふだんのことばで教えてください。', '語彙の質問文': '「{語}」は、なんといいますか？', '例文の質問文': '「{文}」は、なんといいますか？',
    '録音の上限（秒）': '30', '雑音の注意の目安（dB）': '15', '参加者ナンバーの頭文字': 'ka', 'サイトのURL': ' https://example.github.io/site/ ' };
  const r = admin('saveSettings', { values });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.settings, { open: true, notice: '10/20 は、お休みします。', instruction: 'ふだんのことばで教えてください。', wordQuestion: '「{語}」は、なんといいますか？',
    sentenceQuestion: '「{文}」は、なんといいますか？', maxRecordSec: 30, noiseWarnDb: 15, idPrefix: 'KA', siteUrl: 'https://example.github.io/site/' });
  assert.strictEqual(setting('お知らせ'), '10/20 は、お休みします。');
  assert.strictEqual(setting('録音の上限（秒）'), 30); assert.strictEqual(setting('雑音の注意の目安（dB）'), 15);
  const login = w.post({ action: 'login', id: people[0].id, password: people[0].pw });
  const boot = w.post({ action: 'bootstrap', token: login.token });
  assert.strictEqual(boot.settings.notice, '10/20 は、お休みします。'); assert.strictEqual(boot.settings.maxRecordSec, 30); assert.strictEqual(boot.settings.noiseWarnDb, 15);
  assert.strictEqual(admin('addParticipants', { count: 1 }).added[0].id, 'KA001');
  assert.strictEqual(admin('overview').noiseTh, 15);
  assert.ok(/録音フォルダ/.test(w.sheetRows('設定').map(x => x[0]).join()), '録音フォルダの行が消えた');
  assert.ok(/^https:/.test(setting('録音フォルダ')));
});
test('数字や日付に見える文字を入れても、文字のまま残る', () => {
  for (const text of ['0123', '10/20', '2026-10-20', '1e5', "'かっこ", '=SUM(1,2)', '+81']) {
    const r = admin('saveSettings', { values: { 'お知らせ': text } });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.settings.notice, text, text);
    assert.strictEqual(typeof setting('お知らせ'), 'string');
  }
  assert.strictEqual(w.ss.sheets.reduce((n, s) => n + s.formulas.length, 0), 0);
  assert.strictEqual(admin('saveSettings', { values: { 'お知らせ': '' } }).settings.notice, '');
});
test('決まりに合わない値は保存しない（ほかの値も書きこまない）', () => {
  const before = JSON.stringify(w.sheetRows('設定'));
  const bad = [
    { '語彙の質問文': 'なんといいますか？' }, { '例文の質問文': '{語} をなんといいますか' },
    { '録音の上限（秒）': '4' }, { '録音の上限（秒）': '61' }, { '録音の上限（秒）': '12.5' }, { '録音の上限（秒）': 'abc' }, { '録音の上限（秒）': '' },
    { '録音の上限（秒）': '0x10' }, { '録音の上限（秒）': '1e1' }, { '録音の上限（秒）': [30] }, { '録音の上限（秒）': '-30' }, { '録音の上限（秒）': null },
    { '雑音の注意の目安（dB）': '3' }, { '雑音の注意の目安（dB）': '41' }, { '雑音の注意の目安（dB）': '' }, { '雑音の注意の目安（dB）': 'x' },
    { '雑音の注意の目安（dB）': '1e1' }, { '雑音の注意の目安（dB）': '0x14' }, { '雑音の注意の目安（dB）': [20] }, { '雑音の注意の目安（dB）': '20dB' },
    { '参加者ナンバーの頭文字': '' }, { '参加者ナンバーの頭文字': 'あ' }, { '参加者ナンバーの頭文字': 'ABCDE' }, { '参加者ナンバーの頭文字': 'K-' },
    { 'サイトのURL': 'http://example.com/' }, { 'サイトのURL': 'javascript:alert(1)' }, { 'サイトのURL': 'https://example.com/ x' }, { 'サイトのURL': 'https://' + 'a'.repeat(300) + '.example/' },
    { 'お知らせ': '書きこまれてはいけない', '録音の上限（秒）': '999' }
  ];
  for (const values of bad) {
    const r = admin('saveSettings', { values });
    assert.strictEqual(r.ok, false, JSON.stringify(values)); assert.strictEqual(r.error, 'invalid'); assert.ok(r.message.length > 5);
  }
  assert.strictEqual(JSON.stringify(w.sheetRows('設定')), before);
  assert.strictEqual(admin('saveSettings', { values: { '雑音の注意の目安（dB）': '17.5', '録音の上限（秒）': '２５' } }).settings.noiseWarnDb, 17.5, '小数や、全角の数字は受けつける');
  assert.strictEqual(setting('録音の上限（秒）'), 25);
  assert.strictEqual(admin('saveSettings', { values: { '録音の上限（秒）': 30 } }).settings.maxRecordSec, 30);
  assert.strictEqual(admin('saveSettings', { values: { '雑音の注意の目安（dB）': '0' } }).settings.noiseWarnDb, 0, '0 は「注意を出さない」');
  assert.strictEqual(admin('saveSettings', { values: { 'サイトのURL': '' } }).settings.siteUrl, '', '空にもどせる');
});
test('長すぎる文章は、切らずにことわる（ほかの値も書きこまない）', () => {
  for (const [key, max] of [['お知らせ', 300], ['教示文', 400], ['語彙の質問文', 200], ['例文の質問文', 200]]) {
    const before = JSON.stringify(w.sheetRows('設定'));
    const mark = key === '語彙の質問文' ? '{語}' : (key === '例文の質問文' ? '{文}' : '');
    const r = admin('saveSettings', { values: { '録音の上限（秒）': '25', [key]: mark + 'あ'.repeat(max + 1 - mark.length) } });
    assert.strictEqual(r.error, 'invalid', key); assert.ok(r.message.indexOf(key) >= 0 && r.message.indexOf(max + ' 文字まで') >= 0, r.message);
    assert.strictEqual(JSON.stringify(w.sheetRows('設定')), before, key + '：ことわったのに、書きかえた');
    const ok = admin('saveSettings', { values: { [key]: mark + 'あ'.repeat(max - mark.length) } });
    assert.strictEqual(ok.ok, true, key + '：ちょうど上限の長さは受けつける');
  }
  admin('saveSettings', { values: { 'お知らせ': '', '教示文': 'ふだんのことばで教えてください。', '語彙の質問文': '「{語}」は、なんといいますか？', '例文の質問文': '「{文}」は、なんといいますか？' } });
});
test('「設定」シートに同じ項目の行が2つあっても、受付を止められる', () => {
  const sh = sheet('設定');
  sh.appendRow(['受付', '受付中', '（まちがって、もう1行できたもの）']);
  assert.strictEqual(admin('saveSettings', { values: { '受付': '停止中' } }).settings.open, false);
  assert.deepStrictEqual(w.sheetRows('設定').filter(x => x[0] === '受付').map(x => x[1]), ['停止中', '停止中']);
  assert.strictEqual(w.post({ action: 'login', id: people[0].id, password: people[0].pw }).error, 'closed');
  assert.strictEqual(admin('saveSettings', { values: { '受付': '受付中' } }).settings.open, true);
  assert.strictEqual(w.post({ action: 'login', id: people[0].id, password: people[0].pw }).ok, true);
  sh.rows.pop();
});
test('「設定」シートや「項目」シートが見つからないときは、そのことを知らせる（わけのわからないエラーにしない）', () => {
  const sh = sheet('設定');
  sh.name = '設定のコピー';
  let o = admin('overview');
  assert.strictEqual(o.ok, true); assert.ok(o.problems.some(x => /「設定」シートが見つかりません/.test(x)), o.problems.join(' / '));
  const r = admin('saveSettings', { values: { 'お知らせ': 'x' } });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/「設定」シートが見つかりません/.test(r.message), r.message);
  sh.name = '設定';
  const it = sheet('項目');
  it.name = '項目（古い）';
  o = admin('overview');
  assert.strictEqual(o.ok, true); assert.ok(o.problems.some(x => /「項目」シートが見つかりません/.test(x)));
  it.name = '項目';
  assert.deepStrictEqual(admin('overview').problems, []);
});
test('知らない項目・録音フォルダなどは、ここからは変えられない', () => {
  const folder = setting('録音フォルダ');
  const n = w.sheetRows('設定').length;
  const r = admin('saveSettings', { values: { '録音フォルダ': 'https://evil.example/', 'あたらしい項目': 'x', '__proto__': { a: 1 } } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(setting('録音フォルダ'), folder); assert.strictEqual(w.sheetRows('設定').length, n);
  assert.strictEqual(admin('saveSettings', {}).ok, true); assert.strictEqual(admin('saveSettings', { values: 'x' }).ok, true);
});
test('プログラムを新しくしたとき：前からある「設定」シートに「サイトのURL」の行が足される', () => {
  const sh = sheet('設定');
  const i = sh.rows.findIndex(r => r[0] === 'サイトのURL');
  sh.rows.splice(i, 1);
  assert.strictEqual(admin('overview').settings.siteUrl, '', '行がなくても動く');
  const msg = w.call('setup');
  assert.ok(/サイトのURL/.test(msg));
  assert.strictEqual(setting('サイトのURL'), '');
  assert.strictEqual(admin('saveSettings', { values: { 'サイトのURL': 'https://example.github.io/site/' } }).settings.siteUrl, 'https://example.github.io/site/');
});

Date.now = realNow;
console.log(`\n${passed} 件のテストに合格` + (process.exitCode ? '（失敗あり）' : ''));
