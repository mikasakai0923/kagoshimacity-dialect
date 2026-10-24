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
  assert.strictEqual(boot.mode, 'web'); assert.strictEqual(boot.version, '0.5.0'); assert.strictEqual(boot.hours, 12);
  assert.strictEqual(admin('overview', {}, boot.token).ok, true);
  assert.ok(openAsWeb('OWNER@Example.com')._html, 'メールアドレスの大文字・小文字のちがいで開けない');
  assert.ok(openAsWeb(w.OWNER, { admin: '' })._html, '?admin だけでも開ける');
});
test('?admin を付けないときは、これまでどおり動作確認の返事をする', () => {
  const r = JSON.parse(openAsWeb('', {}).getContent());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ready, true); assert.strictEqual(r.version, '0.5.0');
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

console.log('項目：表から取りこむ・直す・足す');
const itemHead = () => w.sheetRows('項目')[0];
const itemRows = () => w.sheetRows('項目').slice(1).filter(r => r.some(v => v !== '' && v != null));
const itemById = id => itemRows().find(r => r[itemHead().indexOf('設問ID')] === id);
const ITEM_HEAD = ['歩', '順', '設問ID', '種別', '提示語・例文', '場面・意味・読み', '提案例文（語彙）', '文節の区切り', 'イラスト', '出す', '記述項目', '調査の狙い'];
const row = (step, order, id, type, prompt, context, example, segs, show) => [step, order, id, type, prompt, context || '', example || '', segs || '', '', show === undefined ? true : show, '', ''];
const answersOf = id => w.sheetRows('回答').slice(1).filter(r => r[col('設問ID')] === id).length;
let kept5 = [];
test('全体のようす：出さない設問も、設問ごとの回答の数も、歩の表も、控えの一覧も渡す', () => {
  const o = admin('overview');
  assert.ok(Array.isArray(o.stepRows) && o.stepRows.length === 2 && o.stepRows[0].title === '鹿児島中央駅');
  assert.deepStrictEqual(o.backups, []);
  assert.strictEqual(o.limits.items, 2000);
  const s1 = o.items.find(i => i.id === 'S001');
  assert.strictEqual(s1.hidden, false); assert.strictEqual(s1.answers, answersOf('S001')); assert.ok(s1.rowNo >= 2);
});
test('下見：見出しの足りない表・空の表はことわる（何も書きこまない）', () => {
  const before = JSON.stringify(w.sheetRows('項目'));
  let r = admin('checkItems', { head: ['歩', '設問ID'], rows: [[1, 'X']], mode: 'replace' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.plan.ok, false);
  assert.ok(/「提示語・例文」/.test(r.plan.errors[0]), r.plan.errors[0]);
  r = admin('checkItems', { head: [], rows: [], mode: 'replace' });
  assert.strictEqual(r.plan.ok, false); assert.ok(/空です/.test(r.plan.errors[0]));
  r = admin('importItems', { head: ['歩', '設問ID'], rows: [[1, 'X']], mode: 'replace', confirm: true });
  assert.strictEqual(r.error, 'invalid');
  assert.strictEqual(JSON.stringify(w.sheetRows('項目')), before);
});
test('下見：行ごとの直すところ（空のID・同じID・歩が数字でない・長すぎる文・種別のまちがい）を、行番号つきで返す', () => {
  const rows = [
    row(1, 1, '', '語彙', '頭'),
    row(1, 2, 'A1', '例文', '頭が痛い。', '', '', '頭が｜痛い'),
    row('x', 3, 'A2', '語彙', '目'),
    row(1, 4, 'A1', '語彙', '鼻'),
    row(1, 5, 'A3', 'ことば', '口'),
    row(1, 6, 'A4', '語彙', 'あ'.repeat(301)),
    row(1, 7, 'A5', '語彙', '耳', '', '', '', 'たぶん')
  ];
  const r = admin('checkItems', { head: ITEM_HEAD, rows, mode: 'replace' });
  assert.strictEqual(r.plan.ok, false);
  const at = n => r.plan.rowErrors.find(e => e.row === n);
  assert.ok(/設問IDが空/.test(at(2).messages[0]));
  assert.ok(/「歩」は 1〜999/.test(at(4).messages[0]));
  assert.ok(/3 行目にもあります/.test(at(5).messages[0]), at(5).messages[0]);
  assert.ok(/「語彙」か「例文」/.test(at(6).messages[0]));
  assert.ok(/長すぎます（301 文字/.test(at(7).messages[0]));
  assert.strictEqual(at(3), undefined); assert.strictEqual(at(8), undefined);
  assert.ok(r.plan.rowWarnings.some(x => x.row === 8 && /「出す」の「たぶん」/.test(x.messages[0])));
  assert.ok(/6 行に/.test(r.plan.errors[0]) || r.plan.errors.some(e => /行に/.test(e)));
});
test('下見：見出しが半角の括弧でも読む。知らない列は使わない。文節と文が合わないときは注意', () => {
  const head = ITEM_HEAD.map(h => h.replace('（語彙）', '(語彙)')).concat(['メモ']);
  const rows = [row(1, 1, 'B1', '例文', '雨が降っている。', '', '', '雨が｜ふっている').concat(['x'])];
  const r = admin('checkItems', { head, rows, mode: 'replace' });
  assert.strictEqual(r.plan.ok, true);
  assert.ok(r.plan.head.used.indexOf('提案例文（語彙）') >= 0);
  assert.deepStrictEqual(r.plan.head.unused, ['メモ']);
  assert.ok(r.plan.rowWarnings.some(x => /合いません/.test(x.messages[0])));
});
test('下見：ちがい（足す・直す・消す）と、回答のある設問への注意を出す', () => {
  const cur = itemRows();
  const rows = cur.map(r => r.slice());
  rows[0][4] = '頭（あたま）';                               // S001 の提示語を変える（回答あり）
  rows[2][6] = '';                                          // S003 の提案例文を消す
  rows.splice(4, 1);                                        // S005 を消す（回答あり）
  rows.push(row(3, 1, 'N001', '語彙', '新しい語'));
  const r = admin('checkItems', { head: itemHead(), rows, mode: 'replace', steps: [[3, '三歩目', 'tree']] });
  assert.strictEqual(r.plan.ok, true);
  const d = r.plan.diff;
  assert.deepStrictEqual(d.added.map(a => a.id), ['N001']);
  assert.deepStrictEqual(d.changed.map(c => [c.id, c.fields.join(','), c.big]), [['S001', '提示語・例文', true], ['S003', '提案例文（語彙）', false]]);
  assert.deepStrictEqual(d.removed.map(x => [x.id, x.kept]), [['S005', true]]);
  assert.strictEqual(d.unchanged, 2);
  assert.strictEqual(r.plan.counts.answersTouched, answersOf('S001'));
  assert.ok(r.plan.warnings.some(x => /回答のある設問の、提示語/.test(x)));
  assert.ok(r.plan.warnings.some(x => /回答のある 1 件は消さずに/.test(x)));
  assert.deepStrictEqual(r.plan.steps, [{ no: 3, title: '三歩目', icon: 'tree' }]);
  assert.strictEqual(r.plan.items, undefined, '下見では、表そのものは返さない');
  // 「足す・直すだけ」なら消えない
  const m = admin('checkItems', { head: itemHead(), rows, mode: 'merge' });
  assert.deepStrictEqual(m.plan.diff.removed, []);
});
test('取りこむ（ぜんぶ入れかえる）：控えをとり、表のとおりに書き、回答のある設問は「出さない」で残す。歩の名前も入る', () => {
  const cur = itemRows();
  const rows = cur.map(r => r.slice());
  rows[0][4] = '頭（あたま）';
  rows.splice(4, 1);
  rows.push(row(3, 1, 'N001', '語彙', '新しい語', '読み：あたらしいご'));
  const nSheets = w.ss.getSheets().length;
  assert.strictEqual(admin('importItems', { head: itemHead(), rows, mode: 'replace', steps: [[3, '三歩目', 'tree']] }).error, 'bad_request', 'confirm なしでは書かない');
  const r = admin('importItems', { head: itemHead(), rows, mode: 'replace', steps: [[3, '三歩目', 'tree']], confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.written, 5); assert.strictEqual(r.hiddenKept, 1);
  assert.strictEqual(r.backups.length, 2);
  assert.ok(/^項目（控え 2026-10-12 14:00）$/.test(r.backups[0]), r.backups[0]);
  assert.strictEqual(w.ss.getSheets().length, nSheets + 2);
  const bk = w.sheetRows(r.backups[0]);
  assert.strictEqual(bk.length, 6); assert.strictEqual(String(bk[1][4]), '頭', '控えは前の内容');
  const now = itemRows();
  assert.strictEqual(now.length, 6);
  assert.strictEqual(now[0][4], '頭（あたま）');
  assert.strictEqual(now[4][2], 'N001'); assert.strictEqual(now[4][0], 3);
  assert.deepStrictEqual([now[5][2], now[5][9]], ['S005', false], '回答のある S005 は出さないで残る');
  assert.strictEqual(JSON.stringify(w.sheetRows('歩').slice(1)), JSON.stringify([[1, '鹿児島中央駅', 'station'], [2, '桜島', 'volcano'], [3, '三歩目', 'tree']]));
  // 参加者の画面には、出す設問だけが届く
  const items = w.call('ksReadItems_');
  assert.strictEqual(JSON.stringify(items.map(i => i.id)), JSON.stringify(['S001', 'S002', 'S003', 'S004', 'N001']));
  const o = admin('overview');
  assert.strictEqual(o.items.find(i => i.id === 'S005').hidden, true);
  assert.strictEqual(o.items.find(i => i.id === 'S005').answers, answersOf('S005'));
  assert.deepStrictEqual(o.backups, [r.backups[0].replace(/^項目（控え (.+)）$/, '$1')]);
  assert.strictEqual(o.steps.length, 3);
});
test('取りこむ（足す・直すだけ）：表にない設問はそのまま。調査者が足した列も残る', () => {
  const sh = sheet('項目');
  sh.getRange(1, 13).setValue('わたしのメモ');
  sh.getRange(2, 13).setValue('S001 のメモ');
  const r = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま'), row(3, 2, 'N002', '例文', '新しい文。', '', '', '新しい｜文')], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.written, 2);
  const now = itemRows();
  assert.strictEqual(now.length, 7);
  assert.strictEqual(now[0][4], '頭'); assert.strictEqual(now[0][12], 'S001 のメモ', '足した列は残る');
  assert.strictEqual(now[6][2], 'N002');
  assert.strictEqual(JSON.stringify(w.call('ksReadItems_').map(i => i.id)), JSON.stringify(['S001', 'S002', 'S003', 'S004', 'N001', 'N002']));
  sh.getRange(1, 13).setValue(''); sh.getRange(2, 13).setValue('');
});
test('取りこむ：順が空なら表の順になる。設問IDの前後の空白・全角は、そろえる', () => {
  const r = admin('importItems', { head: ['歩', '設問ID', '提示語・例文'], rows: [[4, ' Ｃ１ ', 'いち'], [4, 'C2', 'に'], [4, 'C3', 'さん']], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const got = w.call('ksReadItems_').filter(i => i.step === 4);
  assert.strictEqual(JSON.stringify(got.map(i => [i.id, i.order, i.type])), JSON.stringify([['C1', 1, '語彙'], ['C2', 2, '語彙'], ['C3', 3, '語彙']]));
  assert.strictEqual(JSON.stringify(w.sheetRows('歩').slice(1).map(x => x[0])), JSON.stringify([1, 2, 3, 4]), '歩の行が足される');
});
test('同じ分に2回取りこんでも、2回目の控えは秒つきの名前でとられる（前の控えは消えない）', () => {
  clock = Math.ceil(clock / 60000) * 60000 + 120000 + 10000;         // まっさらな分の 10 秒
  const r1 = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge', confirm: true });
  clock += 30000;
  const r2 = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま（2回目）')], mode: 'merge', confirm: true });
  assert.strictEqual(r1.ok && r2.ok, true, JSON.stringify([r1, r2]));
  assert.ok(/^項目（控え 2026-10-12 \d\d:\d\d）$/.test(r1.backups[0]), r1.backups[0]);
  assert.ok(/^項目（控え 2026-10-12 \d\d:\d\d:40）$/.test(r2.backups[0]), r2.backups[0]);
  const names = w.ss.getSheets().map(s => s.getName());
  assert.ok(names.indexOf(r1.backups[0]) >= 0 && names.indexOf(r2.backups[0]) >= 0, names.join(' / '));
  const second = w.ss.getSheetByName(r2.backups[0]);
  assert.strictEqual(String(second.getRange(2, 6).getValue()), '読み：あたま', '2回目の控えには、1回目の取りこみのあとの内容が入る');
});
test('控えは、決まった数だけ残して、古いものから消える', () => {
  const names = () => w.ss.getSheets().map(s => s.getName()).filter(n => /^項目（控え/.test(n));
  for (let i = 0; i < 6; i++) {
    clock += 60000;
    const r = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge', confirm: true });
    assert.strictEqual(r.ok, true);
  }
  kept5 = names();
  assert.strictEqual(kept5.length, 5, kept5.join(' / '));
  assert.strictEqual(w.ss.getSheets().map(s => s.getName()).filter(n => /^歩（控え/.test(n)).length, 5);
  assert.strictEqual(admin('overview').backups.length, 5);
});
test('設問を直す：送った欄だけ変わる。長すぎる文・歩のまちがいはことわる', () => {
  const r = admin('setItem', { id: 'S002', fields: { prompt: '頭が痛い！', segments: '頭が｜痛い', context: '痛いとき' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.item.prompt, r.item.context, r.item.segments, r.item.hidden, r.item.answers], ['頭が痛い！', '痛いとき', ['頭が', '痛い'], false, answersOf('S002')]);
  const sr = itemById('S002');
  assert.strictEqual(sr[4], '頭が痛い！'); assert.strictEqual(sr[5], '痛いとき'); assert.strictEqual(sr[8], 'head', 'さわっていない欄はそのまま');
  assert.strictEqual(admin('setItem', { id: 'S002', fields: { prompt: 'あ'.repeat(301) } }).error, 'invalid');
  assert.strictEqual(admin('setItem', { id: 'S002', fields: { step: 0 } }).error, 'invalid');
  assert.strictEqual(admin('setItem', { id: 'S002', fields: { prompt: '' } }).error, 'invalid');
  assert.strictEqual(admin('setItem', { id: 'NAI', fields: { prompt: 'x' } }).error, 'not_found');
  assert.strictEqual(itemById('S002')[4], '頭が痛い！', 'ことわったときは書きかえない');
});
test('設問を直す：「=」で始まる文も数式にならない。ふりがなは残る', () => {
  const r = admin('setItem', { id: 'S003', fields: { prompt: '=目《め》', example: '+目が大きい。' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.item.prompt, '=目《め》');
  assert.strictEqual(w.ss.getSheetByName('項目').formulas.length, 0, '数式として入ってしまった');
  assert.strictEqual(w.call('ksReadItems_').find(i => i.id === 'S003').prompt, '=目《め》');
});
test('出さない・出す：回答は残る。参加者の画面からだけ消える', () => {
  const n = answersOf('S002');
  let r = admin('setItem', { id: 'S002', fields: { show: false } });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.item.hidden, true);
  assert.strictEqual(itemById('S002')[9], false);
  assert.ok(!w.call('ksReadItems_').some(i => i.id === 'S002'));
  assert.strictEqual(answersOf('S002'), n);
  assert.strictEqual(admin('overview').items.find(i => i.id === 'S002').hidden, true);
  r = admin('setItem', { id: 'S002', fields: { show: true } });
  assert.strictEqual(r.item.hidden, false);
  assert.ok(w.call('ksReadItems_').some(i => i.id === 'S002'));
});
test('設問IDの変更：回答があれば変えられない。なければ変えられる（ほかの設問と同じIDにはできない）', () => {
  let r = admin('setItem', { id: 'S001', fields: { id: 'S001X' } });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/回答が/.test(r.message));
  r = admin('setItem', { id: 'N001', fields: { id: 'S001' } });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/もう使われています/.test(r.message));
  r = admin('setItem', { id: 'N001', fields: { id: 'N001-b' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.item.id, 'N001-b');
  assert.ok(itemById('N001-b') && !itemById('N001'));
  r = admin('setItem', { id: 'N001-b', fields: { id: 'a/b' } });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/使えない記号/.test(r.message));
});
test('同じ設問IDの行が2つあるときは、直せない（シートで直してもらう）', () => {
  sheet('項目').appendRow(row(1, 9, 'S001', '語彙', '頭（2つめ）'));
  const r = admin('setItem', { id: 'S001', fields: { prompt: '頭' } });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/2 つあります/.test(r.message), r.message);
  const o = admin('overview');
  assert.strictEqual(o.items.filter(i => i.id === 'S001').length, 2);
  assert.strictEqual(o.items.filter(i => i.id === 'S001' && i.dup).length, 1);
  assert.strictEqual(w.call('ksReadItems_').filter(i => i.id === 'S001').length, 1, '参加者には1つだけ届く');
  const last = sheet('項目').getLastRow();
  sheet('項目').getRange(last, 1, 1, 12).setValues([['', '', '', '', '', '', '', '', '', '', '', '']]);
});
test('設問を足す：IDの重なりはことわる。順が空なら、その歩の最後になる。歩の行がなければ足す', () => {
  let r = admin('addItem', { fields: { id: 'S001', step: 1, prompt: 'x' } });
  assert.strictEqual(r.error, 'invalid'); assert.ok(/もう使われています/.test(r.message));
  r = admin('addItem', { fields: { id: 'N003', step: 7, prompt: '足した語', type: '語彙', context: '読み：たしたご' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.item.id, r.item.step, r.item.order, r.item.type, r.item.hidden], ['N003', 7, 1, '語彙', false]);
  r = admin('addItem', { fields: { id: 'N004', step: 7, prompt: '足した文。', type: '例文', segments: '足した｜文' } });
  assert.strictEqual(r.item.order, 2);
  assert.ok(w.sheetRows('歩').slice(1).some(x => x[0] === 7), '歩の行が足される');
  assert.strictEqual(JSON.stringify(w.call('ksReadItems_').filter(i => i.step === 7).map(i => i.id)), JSON.stringify(['N003', 'N004']));
  assert.strictEqual(admin('addItem', { fields: { id: 'N005', step: 7, prompt: '' } }).error, 'invalid');
});
test('歩の名前：直せる・足せる。長すぎる名前はことわる', () => {
  let r = admin('setStep', { no: 1, title: 'はじめの駅', icon: 'station' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.stringify(w.sheetRows('歩')[1]), JSON.stringify([1, 'はじめの駅', 'station']));
  r = admin('setStep', { no: 12, title: '十二歩目', icon: '' });
  assert.strictEqual(r.ok, true);
  assert.ok(w.sheetRows('歩').slice(1).some(x => x[0] === 12 && x[1] === '十二歩目'));
  assert.strictEqual(admin('setStep', { no: 1, title: 'あ'.repeat(61) }).error, 'invalid');
  assert.strictEqual(admin('setStep', { no: 'x', title: 'a' }).error, 'bad_request');
  assert.strictEqual(admin('overview').stepRows.find(s => s.no === 1).title, 'はじめの駅');
});
test('取りこむ：表にない列は、いまの値のまま（場面・文節・出す・種別が消えない）。下見にもそう出る', () => {
  const before = itemById('S003');
  assert.ok(before[5] && before[8], '前提：S003 には場面とイラストがある');
  admin('setItem', { id: 'S004', fields: { show: false } });
  const plan = admin('checkItems', { head: ['歩', '設問ID', '提示語・例文'], rows: [[1, 'S003', '目！'], [2, 'S004', '雨が降っている！']], mode: 'merge' }).plan;
  assert.strictEqual(plan.ok, true, JSON.stringify(plan.errors));
  assert.ok(plan.head.absent.indexOf('場面・意味・読み') >= 0 && plan.head.absent.indexOf('出す') >= 0, JSON.stringify(plan.head));
  assert.ok(plan.warnings.some(t => /表にない列/.test(t)), JSON.stringify(plan.warnings));
  const ch = plan.diff.changed.find(x => x.id === 'S003');
  assert.deepStrictEqual(ch.fields, ['提示語・例文'], '提示語・例文だけが変わる扱い');
  const r = admin('importItems', { head: ['歩', '設問ID', '提示語・例文'], rows: [[1, 'S003', '目！'], [2, 'S004', '雨が降っている！']], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const now = itemById('S003');
  assert.strictEqual(now[4], '目！');
  assert.strictEqual(now[5], before[5], '場面が消えた'); assert.strictEqual(now[8], before[8], 'イラストが消えた'); assert.strictEqual(now[3], before[3], '種別が変わった');
  const s4 = itemById('S004');
  assert.strictEqual(s4[9], false, '「出さない」が「出す」にもどってしまった'); assert.strictEqual(s4[7], '雨が｜降っている', '文節が消えた');
  admin('setItem', { id: 'S004', fields: { show: true } });
  admin('setItem', { id: 'S003', fields: { prompt: '目' } });
});
test('見出しのない列に書いたことも、調査者が足した列の数式も、直しても取りこんでも残る', () => {
  const sh = sheet('項目');
  const rowS1 = itemRows().findIndex(r => r[2] === 'S001') + 2;
  sh.getRange(1, 13).setValue('数式の列'); sh.getRange(rowS1, 13).setValue('=LEN(E' + rowS1 + ')');
  sh.getRange(rowS1, 14).setValue('見出しのない列のメモ');                 // N1 は空のまま
  assert.strictEqual(sh.formulas.length, 1, '前提：数式が1つ入っている');
  let r = admin('setItem', { id: 'S001', fields: { context: '読み：あたま（直した）' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sh.getRange(rowS1, 14).getValue(), '見出しのない列のメモ', '直したら消えた');
  assert.strictEqual(sh.getRange(rowS1, 13).getFormulas()[0][0], '=LEN(E' + rowS1 + ')', '直したら数式が消えた');
  r = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sh.getRange(rowS1, 14).getValue(), '見出しのない列のメモ', '足す・直すだけで消えた');
  assert.strictEqual(sh.getRange(rowS1, 13).getFormulas()[0][0], '=LEN(E' + rowS1 + ')', '足す・直すだけで数式が消えた');
  const all = itemRows().map(x => x.slice(0, 12));
  r = admin('importItems', { head: ITEM_HEAD, rows: all.slice().reverse(), mode: 'replace', confirm: true });     // 並びを逆にして、ぜんぶ入れかえる
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const rowNow = itemRows().findIndex(x => x[2] === 'S001') + 2;
  assert.notStrictEqual(rowNow, rowS1, '前提：行が動いた');
  assert.strictEqual(sh.getRange(rowNow, 14).getValue(), '見出しのない列のメモ', 'ぜんぶ入れかえると、見出しのない列が行についてこない');
  assert.ok(/^=LEN\(E\d+\)$/.test(sh.getRange(rowNow, 13).getFormulas()[0][0]), 'ぜんぶ入れかえると数式が消えた');
  r = admin('importItems', { head: ITEM_HEAD, rows: all, mode: 'replace', confirm: true });
  assert.strictEqual(r.ok, true);
  sh.getRange(1, 13).setValue(''); sh.getRange(rowS1, 13).setValue(''); sh.getRange(rowS1, 14).setValue('');
});
test('歩のシート：取りこんでも行を消さない・並べかえない。調査者が足した列も残る。出していない設問だけの歩の名前も残る', () => {
  const sh = sheet('歩');
  sh.getRange(1, 4).setValue('歩のメモ'); sh.getRange(2, 4).setValue('1歩目のメモ');
  sh.appendRow([30, '準備中の歩', '']);
  const before = w.sheetRows('歩').slice(1).filter(x => x.some(v => v !== ''));
  const r = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'replace', steps: [[1, '一歩目（新）', 'tree'], [2, '二歩目（新）', '']], confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const now = w.sheetRows('歩').slice(1).filter(x => x.some(v => v !== ''));
  assert.strictEqual(now.length, before.length, '歩の行が消えた：' + JSON.stringify(now));
  assert.strictEqual(now[0][1], '一歩目（新）'); assert.strictEqual(now[0][3], '1歩目のメモ', '足した列がずれた');
  assert.ok(now.some(x => x[0] === 30 && x[1] === '準備中の歩'), '準備中の歩が消えた');
  assert.ok(now.some(x => x[0] === 7), '出していない設問だけの歩（7）の行が消えた');
  // 列を並べかえてあっても、歩の名前は正しい列に入る
  sh.getRange(1, 1, 1, 3).setValues([['タイトル', '歩', 'アイコン']]);
  const rowsNow = w.sheetRows('歩').slice(1).filter(x => x.some(v => v !== '')).map(x => [x[1], x[0], x[2], x[3]]);
  sh.getRange(2, 1, rowsNow.length, 4).setValues(rowsNow);
  let r2 = admin('setStep', { no: 2, title: '二歩目（列を入れかえ）', icon: 'fire' });
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  const r2row = w.sheetRows('歩').slice(1).find(x => x[1] === 2);
  assert.deepStrictEqual([r2row[0], r2row[2]], ['二歩目（列を入れかえ）', 'fire'], JSON.stringify(r2row));
  assert.strictEqual(admin('overview').stepRows.find(x => x.no === 2).title, '二歩目（列を入れかえ）');
  // もとにもどす
  const back = w.sheetRows('歩').slice(1).filter(x => x.some(v => v !== '')).map(x => [x[1], x[0], x[2], x[3]]);
  sh.getRange(1, 1, 1, 3).setValues([['歩', 'タイトル', 'アイコン']]);
  sh.getRange(2, 1, back.length, 4).setValues(back);
  admin('setStep', { no: 1, title: 'はじめの駅', icon: 'station' }); admin('setStep', { no: 2, title: '桜島', icon: 'volcano' });
  sh.getRange(1, 4).setValue(''); sh.getRange(2, 4).setValue('');
});
test('設問IDの中に空白があっても、同じ設問として数える（回答のある設問が消えない）', () => {
  const sh = sheet('項目');
  const rowS2 = itemRows().findIndex(r => r[2] === 'S002') + 2;
  sh.getRange(rowS2, 3).setValue('S 002');
  assert.ok(answersOf('S002') > 0, '前提：S002 に回答がある');
  const o = admin('overview');
  assert.strictEqual(o.items.find(i => i.id === 'S002').answers, answersOf('S002'), '空白入りの設問IDの回答が数えられない');
  const rows = itemRows().filter(r => r[2] !== 'S 002').map(r => r.slice(0, 12));
  const plan = admin('checkItems', { head: ITEM_HEAD, rows, mode: 'replace' }).plan;
  const rm = plan.diff.removed.find(x => x.id === 'S002');
  assert.ok(rm && rm.kept, JSON.stringify(plan.diff.removed));
  const r = admin('importItems', { head: ITEM_HEAD, rows, mode: 'replace', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.hiddenKept, 1);
  const kept = itemRows().find(r => r[2] === 'S 002' || r[2] === 'S002');
  assert.ok(kept && kept[9] === false, '回答のある設問が消えた');
  sh.getRange(itemRows().findIndex(r => r[2] === kept[2]) + 2, 3).setValue('S002');
  admin('setItem', { id: 'S002', fields: { show: true } });
});
test('足す・直すだけ：同じ設問IDの行がシートに2つあるものは、取りこめない。順だけの変更も下見に出る', () => {
  sheet('項目').appendRow(row(1, 9, 'S001', '語彙', '頭（2つめ）'));
  let plan = admin('checkItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge' }).plan;
  assert.strictEqual(plan.ok, false);
  assert.ok(plan.rowErrors.some(e => e.id === 'S001' && /2 つあります/.test(e.messages.join(''))), JSON.stringify(plan.rowErrors));
  const last = sheet('項目').getLastRow();
  sheet('項目').getRange(last, 1, 1, 12).setValues([['', '', '', '', '', '', '', '', '', '', '', '']]);
  plan = admin('checkItems', { head: ITEM_HEAD, rows: [row(1, 5, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge' }).plan;
  assert.strictEqual(plan.ok, true, JSON.stringify(plan.errors));
  const ch = plan.diff.changed.find(x => x.id === 'S001');
  assert.ok(ch && ch.fields.indexOf('順') >= 0 && !ch.big, JSON.stringify(plan.diff));
});
test('設問を直す：順を空欄にすると、その歩の最後になる', () => {
  const r = admin('setItem', { id: 'S001', fields: { order: '' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const ids = w.call('ksReadItems_').filter(i => i.step === 1).map(i => i.id);
  assert.strictEqual(ids[ids.length - 1], 'S001', ids.join(','));
  admin('setItem', { id: 'S001', fields: { order: 1 } });
});
test('「出さない」の切りかえは、歩が空欄の古い行でもできる', () => {
  const sh = sheet('項目');
  sh.appendRow(['', '', 'OLD1', '語彙', '古い行', '', '', '', '', true, '', '']);
  const rowNo = sh.getLastRow();
  let r = admin('setItem', { id: 'OLD1', fields: { show: false } });
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.item.hidden, true);
  assert.strictEqual(sh.getRange(rowNo, 10).getValue(), false);
  r = admin('setItem', { id: 'OLD1', fields: { prompt: '古い行（直す）' } });
  assert.strictEqual(r.error, 'invalid', '歩が空欄のままでは、ほかの欄は直せない');
  sh.getRange(rowNo, 1, 1, 12).setValues([['', '', '', '', '', '', '', '', '', '', '', '']]);
});
test('控え：日時の形でない名前のシートは、控えとして数えない（消さない・一覧に出さない）', () => {
  w.ss.insertSheet('項目（控え 手直し前）');
  const o = admin('overview');
  assert.ok(o.backups.every(b => /^\d{4}-/.test(b)), JSON.stringify(o.backups));
  clock += 60000;
  const r = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true);
  assert.ok(w.ss.getSheetByName('項目（控え 手直し前）'), '手で作ったシートが消された');
  assert.strictEqual(w.ss.getSheets().map(s => s.getName()).filter(n => /^項目（控え \d/.test(n)).length, 5);
  w.ss.deleteSheet(w.ss.getSheetByName('項目（控え 手直し前）'));
});
test('控えからもどす：もどす前にいまの控えをとり、「項目」「歩」の中身が控えのとおりになる', () => {
  const beforeItems = itemRows().map(r => r.slice(0, 12).map(v => String(v)));
  const beforeSteps = w.sheetRows('歩').slice(1).filter(x => x.some(v => v !== '')).map(r => r.slice(0, 3).map(v => String(v)));
  clock += 60000;
  const imp = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'R001', '語彙', 'もどす前の語')], mode: 'replace', steps: [[1, 'もどす前の歩', '']], confirm: true });
  assert.strictEqual(imp.ok, true, JSON.stringify(imp));
  const stamp = imp.backups[0].replace(/^項目（控え (.+)）$/, '$1');
  assert.strictEqual(w.call('ksReadItems_').map(i => i.id).join(','), 'R001');
  assert.strictEqual(admin('restoreItems', { stamp: '2000-01-01 00:00' }).error, 'not_found');
  clock += 60000;
  const r = admin('restoreItems', { stamp });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.restored, stamp); assert.strictEqual(r.backups.length, 2, 'もどす前の控えがとられていない');
  assert.strictEqual(JSON.stringify(itemRows().map(x => x.slice(0, 12).map(v => String(v)))), JSON.stringify(beforeItems), '項目がもどっていない');
  assert.strictEqual(JSON.stringify(w.sheetRows('歩').slice(1).filter(x => x.some(v => v !== '')).map(x => x.slice(0, 3).map(v => String(v)))), JSON.stringify(beforeSteps), '歩がもどっていない');
  assert.ok(w.call('ksReadItems_').some(i => i.id === 'S001') && !w.call('ksReadItems_').some(i => i.id === 'R001'));
  assert.ok(w.ss.getSheetByName('項目（控え ' + r.backups[0].replace(/^項目（控え (.+)）$/, '$1') + '）'));
});
test('さわらない行の、決まった列（調査の狙いなど）にある数式も、取りこみ・直しで消えない', () => {
  const sh = sheet('項目');
  const rowS3 = itemRows().findIndex(r => r[2] === 'S003') + 2;
  sh.getRange(rowS3, 12).setNumberFormat('General').setValue('=LEN(E' + rowS3 + ')');   // 調査の狙い の列に数式（書式は「自動」）
  assert.strictEqual(sh.getRange(rowS3, 12).getFormulas()[0][0], '=LEN(E' + rowS3 + ')');
  let r = admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sh.getRange(rowS3, 12).getFormulas()[0][0], '=LEN(E' + rowS3 + ')', 'さわらない行の数式が消えた');
  r = admin('setItem', { id: 'S003', fields: { context: '読み：め（直した）' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sh.getRange(rowS3, 12).getFormulas()[0][0], '=LEN(E' + rowS3 + ')', '直した行の、送っていない欄の数式が消えた');
  assert.strictEqual(itemById('S003')[5], '読み：め（直した）');
  r = admin('importItems', { head: ['歩', '設問ID', '提示語・例文'], rows: [[1, 'S003', '目']], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sh.getRange(rowS3, 12).getFormulas()[0][0], '=LEN(E' + rowS3 + ')', '表にない列の数式が、値に変わった');
  sh.getRange(rowS3, 12).setValue('');
});
test('順の列がない表：ぜんぶ入れかえると表の順になる。足す・直すだけなら、前からある設問は順のまま、新しい設問は歩の最後', () => {
  const cur = itemRows().filter(r => r[9] !== false).map(r => r.slice(0, 12));
  const noOrder = cur.map(r => [r[0], r[2], r[4]]);
  const swapped = noOrder.slice(); const t = swapped[0]; swapped[0] = swapped[1]; swapped[1] = t;
  let plan = admin('checkItems', { head: ['歩', '設問ID', '提示語・例文'], rows: swapped, mode: 'replace' }).plan;
  assert.strictEqual(plan.ok, true, JSON.stringify(plan.errors));
  assert.ok(plan.diff.changed.some(x => x.fields.indexOf('順') >= 0), '順が変わることが下見に出ない');
  let r = admin('importItems', { head: ['歩', '設問ID', '提示語・例文'], rows: swapped, mode: 'replace', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const got = w.call('ksReadItems_').map(i => i.id);
  assert.strictEqual(got.slice(0, 2).join(','), swapped[0][1] + ',' + swapped[1][1], '表の順になっていない：' + got.join(','));
  // もとの順にもどす
  admin('importItems', { head: ['歩', '設問ID', '提示語・例文'], rows: noOrder, mode: 'replace', confirm: true });
  const before = w.call('ksReadItems_').filter(i => i.step === 1).map(i => i.id + ':' + i.order).join(',');
  plan = admin('checkItems', { head: ['歩', '設問ID', '提示語・例文'], rows: [[1, 'S001', '頭'], [1, 'NEW9', '新しい設問']], mode: 'merge' }).plan;
  assert.ok(!plan.diff.changed.some(x => x.id === 'S001' && x.fields.indexOf('順') >= 0), '足す・直すだけで、順が変わる扱いになっている');
  r = admin('importItems', { head: ['歩', '設問ID', '提示語・例文'], rows: [[1, 'S001', '頭'], [1, 'NEW9', '新しい設問']], mode: 'merge', confirm: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const after = w.call('ksReadItems_').filter(i => i.step === 1);
  assert.strictEqual(after.filter(i => i.id !== 'NEW9').map(i => i.id + ':' + i.order).join(','), before, '前からある設問の順が変わった');
  assert.strictEqual(after[after.length - 1].id, 'NEW9', '新しい設問が歩の最後に来ない');
  admin('importItems', { head: ITEM_HEAD, rows: itemRows().filter(x => x[2] !== 'NEW9').map(x => x.slice(0, 12)), mode: 'replace', confirm: true });
});
test('控えからもどす：いちばん古い控えをえらんでも、消される前に読んでもどせる。項目と歩の控えは同じ日時', () => {
  const names = () => w.ss.getSheets().map(x => x.getName()).filter(n => /^項目（控え \d/.test(n)).map(n => n.replace(/^項目（控え (.+)）$/, '$1')).sort();   // 日時の順
  for (let i = 0; names().length < 5; i++) { clock += 60000; admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'S001', '語彙', '頭', '読み：あたま')], mode: 'merge', confirm: true }); }
  const oldest = names()[0];
  const trim = rows => rows.map(x => { const y = x.map(v => String(v)); while (y.length && y[y.length - 1] === '') y.pop(); return y; }).filter(y => y.length);
  const oldestRows = JSON.stringify(trim(w.sheetRows('項目（控え ' + oldest + '）')));
  assert.ok(w.ss.getSheetByName('歩（控え ' + oldest + '）'), '項目と歩の控えの日時がちがう');
  clock += 60000;
  const r = admin('restoreItems', { stamp: oldest });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(JSON.stringify(trim(w.sheetRows('項目'))), oldestRows, 'いちばん古い控えの中身にもどっていない');
  assert.ok(!w.ss.getSheetByName('項目（控え ' + oldest + '）'), '（古い控えは、新しい控えをとったときに消える）' + JSON.stringify([oldest, names(), r.backups]));
  assert.strictEqual(r.backups.length, 2);
  assert.strictEqual(r.backups[0].replace(/^項目/, ''), r.backups[1].replace(/^歩/, ''), '項目と歩の控えの日時がちがう');
});
test('初期設定：「項目」シートの足りない見出しを足す（消してしまった列を直せる）', () => {
  const sh = sheet('項目');
  const col = itemHead().indexOf('調査の狙い') + 1;
  sh.getRange(1, col).setValue('');
  const keepLog = console.log; console.log = () => {};
  try { w.call('setup'); } finally { console.log = keepLog; }
  assert.ok(itemHead().indexOf('調査の狙い') >= 0, '見出しが足されない');
  if (itemHead().indexOf('調査の狙い') + 1 !== col) {                  // 右はしに足されたときは、もとの列にもどす
    sh.getRange(1, itemHead().indexOf('調査の狙い') + 1).setValue('');
    sh.getRange(1, col).setValue('調査の狙い');
  }
});
test('「項目」シートが見つからないときは、取りこみも直すこともことわる（わけのわからないエラーにしない）', () => {
  const it = sheet('項目');
  it.name = '項目（古い）';
  assert.ok(/「項目」シートが見つかりません/.test(admin('setItem', { id: 'S001', fields: { prompt: 'x' } }).message));
  assert.ok(/「項目」シートが見つかりません/.test(admin('importItems', { head: ITEM_HEAD, rows: [row(1, 1, 'Z1', '語彙', 'x')], mode: 'merge', confirm: true }).message));
  it.name = '項目';
});
test('多すぎる表（2001 件）はことわる', () => {
  const rows = [];
  for (let i = 0; i < 2001; i++) rows.push(row(1, i + 1, 'M' + i, '語彙', 'x' + i));
  const r = admin('checkItems', { head: ITEM_HEAD, rows, mode: 'replace' });
  assert.strictEqual(r.plan.ok, false); assert.ok(/多すぎます/.test(r.plan.errors[0]));
});

Date.now = realNow;
console.log(`\n${passed} 件のテストに合格` + (process.exitCode ? '（失敗あり）' : ''));
