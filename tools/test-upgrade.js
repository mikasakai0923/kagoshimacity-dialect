#!/usr/bin/env node
/*
 * 開発用：プログラムの「入れかえ」の予行。
 * いま動いている版（古いプログラム）で回答をためてから、同じ表のまま新しいプログラムに入れかえて、
 * 回答・参加者・録音・設定がそのまま残り、参加者が続けて使えることを確かめます。
 *
 *   node tools/test-upgrade.js <古いプログラム> [新しいプログラム（なければ gas/Code.gs）]
 *
 * 古いプログラムは、たとえば次のようにして取り出せます（0.3.3 のころの版）：
 *   git show 1213f8b:gas/Code.gs > /tmp/Code.old.gs
 *
 * Google 側は tools/mock-gas.js（まねサーバー）を使います。本物の Google へは、決して送りません。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createGasWorld } = require('./mock-gas');
const { speechWav } = require('./seed-admin');

const args = process.argv.slice(2);
if (!args[0]) { console.error('使い方：node tools/test-upgrade.js <古いプログラム> [新しいプログラム]'); process.exit(2); }
const OLD = path.resolve(args[0]);
const NEW = path.resolve(args[1] || path.join(__dirname, '..', 'gas', 'Code.gs'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  NG  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
}
const quiet = fn => { const keep = console.log; console.log = () => {}; try { return fn(); } finally { console.log = keep; } };

// ---- 古い版で、ふだんどおりに使う ----
const w = createGasWorld(OLD);
quiet(() => w.call('setup'));
const verOld = vm.runInContext('KS_VERSION', w.sandbox);
quiet(() => w.call('addParticipants', 4));
const people = w.sheetRows('参加者').slice(1).map(r => ({ id: r[0], pw: r[1] }));
const items = w.call('ksReadItems_');
const wav = speechWav(1.5, 0.03, 0.0004).toString('base64');
const save = (token, i, sid) => w.post({ action: 'save', token, submission: {
  submissionId: sid, itemId: items[i % items.length].id, step: items[i % items.length].step, type: items[i % items.length].type, prompt: items[i % items.length].prompt,
  status: '回答済', answer: 'こたえ' + i, device: 'iPhone', clientTime: '2026-10-12T16:58:24+09:00',
  audio: [{ slot: 'main', b64: wav, sampleRate: 16000, durationSec: 1.5, peak: 0.03, snrDb: 35, noiseDb: -66 }] } });
const logins = people.map(p => w.post({ action: 'login', id: p.id, password: p.pw }));

console.log('入れかえの予行（' + verOld + ' → 新しい版）');
test('古い版：ログインと保存ができる', () => {
  for (const l of logins) assert.strictEqual(l.ok, true, JSON.stringify(l));
  for (let i = 0; i < 12; i++) assert.strictEqual(save(logins[i % 3].token, i, 'old-' + String(i).padStart(6, '0')).saved, true);
});
// 調査者が手で書きかえてある内容（入れかえても、そのまま残るはず）
const set = w.ss.getSheetByName('設定');
const rowOf = key => set.rows.findIndex(r => r[0] === key);
set.rows[rowOf('お知らせ')][1] = '手で書いたお知らせ';
set.rows[rowOf('録音の上限（秒）')][1] = 30;
w.ss.getSheetByName('参加者').rows[1][3] = '手で書いたメモ';
const filesNow = () => w.files().map(f => f.path + ':' + f.bytes).sort();
const before = {
  answers: w.sheetRows('回答'), people: JSON.stringify(w.sheetRows('参加者')), items: JSON.stringify(w.sheetRows('項目')), steps: JSON.stringify(w.sheetRows('歩')),
  files: filesNow(), secret: w.props.TOKEN_SECRET, folder: w.props.AUDIO_FOLDER_ID, settings: w.sheetRows('設定').map(r => r.slice(0, 2))
};

// ---- 新しいプログラムを貼りつけて保存した直後（まだ初期設定のやり直しも、デプロイのし直しもしていない） ----
vm.runInContext(fs.readFileSync(NEW, 'utf8'), w.sandbox, { filename: path.basename(NEW) });
const verNew = vm.runInContext('KS_VERSION', w.sandbox);
const adminCall = (action, payload) => JSON.parse(w.call('ksAdminCall', w.call('ksMakeAdminToken_'), action, JSON.stringify(payload || {})));

test('新しい版（' + verNew + '）に入れかえた直後：前からログインしている人が、そのまま保存できる', () => {
  assert.strictEqual(save(logins[0].token, 12, 'mid-000001').saved, true);
  const b = w.post({ action: 'bootstrap', token: logins[1].token });
  assert.strictEqual(b.ok, true, JSON.stringify(b).slice(0, 200));
  assert.strictEqual(b.items.length, items.length);
  assert.strictEqual(b.settings.notice, '手で書いたお知らせ');
});
test('初期設定をやり直す前でも、管理画面の中身を作れる', () => {
  const o = adminCall('overview');
  assert.strictEqual(o.ok, true, JSON.stringify(o).slice(0, 200));
  assert.strictEqual(o.totals.rows, 13);
  assert.deepStrictEqual(o.problems, []);
});
let msg = '';
test('初期設定をやり直しても、回答・参加者・項目・録音・かぎは変わらない', () => {
  msg = quiet(() => w.call('setup'));
  const rows = w.sheetRows('回答');
  assert.strictEqual(JSON.stringify(rows.slice(0, before.answers.length).map(r => r.slice(0, before.answers[0].length))), JSON.stringify(before.answers), '前からある回答が変わった');
  assert.strictEqual(JSON.stringify(w.sheetRows('参加者')), before.people);
  assert.strictEqual(JSON.stringify(w.sheetRows('項目')), before.items);
  assert.strictEqual(JSON.stringify(w.sheetRows('歩')), before.steps);
  assert.strictEqual(w.props.TOKEN_SECRET, before.secret);
  assert.strictEqual(w.props.AUDIO_FOLDER_ID, before.folder);
  const now = filesNow();
  for (const f of before.files) assert.ok(now.indexOf(f) >= 0, '録音がなくなった：' + f);
});
test('設定：手で書きかえた値は残る。足りなかった項目の行だけが足される', () => {
  const now = w.sheetRows('設定');
  for (const [k, v] of before.settings) {
    const r = now.find(x => x[0] === k);
    assert.ok(r, '「' + k + '」の行がなくなった');
    assert.strictEqual(String(r[1]), String(v), k);
  }
  const added = now.map(x => x[0]).filter(k => !before.settings.some(x => x[0] === k));
  console.log('        足された行：' + (added.length ? added.join('、') : 'なし') + '　／　' + String(msg).split('\n')[1]);
});
test('入れかえたあと：参加者は、そのまま続けられる（ログイン・保存）', () => {
  assert.strictEqual(save(logins[2].token, 13, 'new-000001').saved, true);
  const l = w.post({ action: 'login', id: people[3].id, password: people[3].pw });
  assert.strictEqual(l.ok, true, JSON.stringify(l));
  assert.strictEqual(save(l.token, 0, 'new-000002').saved, true);
  assert.strictEqual(w.post({ action: 'bootstrap', token: logins[0].token }).ok, true);
});
test('管理画面：前の版でたまった回答も数え、録音も聞ける。開けるのは持ち主だけ', () => {
  const o = adminCall('overview');
  assert.strictEqual(o.totals.rows, 15); assert.strictEqual(o.totals.participants, 4); assert.strictEqual(o.items.length, items.length);
  assert.strictEqual(o.participants[0].memo, '手で書いたメモ');
  const a = adminCall('answers', { limit: 200 });
  assert.strictEqual(a.total, 15);
  const old = a.rows.find(r => r.sid === 'old-000003');
  assert.ok(old && old.a1, JSON.stringify(old).slice(0, 300));
  const au = adminCall('audio', { sid: old.sid, slot: 'main' });
  assert.strictEqual(au.ok, true, JSON.stringify(au).slice(0, 200));
  assert.strictEqual(au.b64, wav, '録音の中身が変わった');
  assert.deepStrictEqual(adminCall('passwords').list.map(x => x.password), people.map(p => p.pw));
  assert.ok(w.asVisitor(w.OWNER, () => w.call('doGet', { parameter: { admin: '1' } }))._html, '持ち主に、管理画面が出ない');
  assert.strictEqual(w.asVisitor('', () => w.call('doGet', { parameter: { admin: '1' } }))._html, undefined);
  assert.strictEqual(w.asVisitor('someone@example.com', () => w.call('doGet', { parameter: { admin: '1' } }))._html, undefined);
  assert.ok(/"ok":true/.test(w.call('doGet', { parameter: {} }).getContent()), '動作確認の返事が変わった');
});

console.log('\n' + passed + ' 件のテストに合格' + (process.exitCode ? '（失敗あり）' : '') + '（' + verOld + ' → ' + verNew + '、設問 ' + items.length + ' 問）');
