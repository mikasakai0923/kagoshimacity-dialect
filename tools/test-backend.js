#!/usr/bin/env node
/*
 * 開発用：Google 側プログラム（gas/Code.gs）の動作テスト。
 *   node tools/test-backend.js
 */
const path = require('path');
const assert = require('assert');
const { createGasWorld } = require('./mock-gas');

const code = path.resolve(process.argv[2] || path.join(__dirname, '..', 'gas', 'Code.gs'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  NG  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
}

function wav(seconds, rate) {
  rate = rate || 48000;
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return buf.toString('base64');
}

const w = createGasWorld(code);
let clock = Date.now();
w.setNow(() => clock);
const realNow = Date.now;
Date.now = () => clock;           // Code.gs の中の Date.now() も同じ時計にする

console.log('初期設定');
test('初期設定の前は「未設定」と答える', () => {
  const r = w.post({ action: 'ping' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'not_ready');
});
test('setup がシートと録音フォルダを作る', () => {
  const msg = w.call('setup');
  assert.ok(/初期設定が終わりました/.test(msg));
  for (const n of ['設定', '参加者', '歩', '項目', '回答']) assert.ok(w.ss.getSheetByName(n), n + ' シートがない');
  assert.strictEqual(w.ss.getSheetByName('シート1'), null, '空のシート1が残っている');
  assert.ok(w.props.SPREADSHEET_ID && w.props.TOKEN_SECRET && w.props.AUDIO_FOLDER_ID);
  assert.strictEqual(w.sheetRows('回答')[0].length, 24);
  assert.ok(w.sheetRows('項目').length >= 3);
  assert.ok(w.sheetRows('設定').some(r => r[0] === '録音フォルダ' && /^https:/.test(r[1])));
});
test('setup を2回実行してもデータが増えない・消えない', () => {
  const before = JSON.stringify(w.ss.sheets.map(s => s.rows));
  const secret = w.props.TOKEN_SECRET, folder = w.props.AUDIO_FOLDER_ID;
  w.call('setup');
  assert.strictEqual(JSON.stringify(w.ss.sheets.map(s => s.rows)), before);
  assert.strictEqual(w.props.TOKEN_SECRET, secret); assert.strictEqual(w.props.AUDIO_FOLDER_ID, folder);
});
test('doGet が動作中と答える', () => {
  const r = JSON.parse(w.call('doGet', { parameter: {} }).getContent());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ready, true);
});

console.log('参加者');
let people;
test('参加者を自動で追加できる（頭のゼロが消えない）', () => {
  const ids = w.call('addParticipants', 3);
  assert.deepStrictEqual(Array.from(ids), ['K001', 'K002', 'K003']);
  people = w.sheetRows('参加者').slice(1);
  for (const p of people) { assert.strictEqual(typeof p[1], 'string'); assert.ok(/^\d{6}$/.test(p[1]), 'パスワードが6けたでない: ' + p[1]); }
  const more = w.call('addParticipants', 2);
  assert.deepStrictEqual(Array.from(more), ['K004', 'K005']);
  people = w.sheetRows('参加者').slice(1);
});
test('手で入力した「007」「012345」が文字のまま残る', () => {
  const sh = w.ss.getSheetByName('参加者');
  sh.appendRow(['007', '012345', '', '手入力', '', '']);
  const last = w.sheetRows('参加者').pop();
  assert.strictEqual(last[0], '007'); assert.strictEqual(last[1], '012345');
});

console.log('ログイン');
let token;
test('正しいナンバーとパスワードでログインできる', () => {
  const r = w.post({ action: 'login', id: people[0][0], password: people[0][1] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.participant.id, 'K001');
  assert.ok(r.expiresAt > clock + 29 * 86400000);
  token = r.token;
  assert.ok(w.sheetRows('参加者')[1][5] instanceof Date, '最終ログインが記録されていない');
});
test('全角・小文字・空白まじりでもログインできる', () => {
  const zen = s => s.replace(/[0-9A-Za-z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
  const r = w.post({ action: 'login', id: ' ' + zen('k001') + '　', password: zen(people[0][1]) + ' ' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
test('ゼロで始まる手入力の参加者もログインできる', () => {
  const r = w.post({ action: 'login', id: '007', password: '012345' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
test('まちがったパスワード・知らないナンバーは同じエラー', () => {
  const a = w.post({ action: 'login', id: 'K002', password: 'xxxxxx' });
  const b = w.post({ action: 'login', id: 'ZZZ999', password: 'xxxxxx' });
  assert.strictEqual(a.error, 'bad_credentials'); assert.strictEqual(b.error, 'bad_credentials');
  assert.strictEqual(a.message, b.message);
});
test('パスワードが空の行ではログインできない', () => {
  w.ss.getSheetByName('参加者').appendRow(['K900', '', '', '', '', '']);
  assert.strictEqual(w.post({ action: 'login', id: 'K900', password: '' }).ok, false);
  assert.strictEqual(w.post({ action: 'login', id: 'K900', password: ' ' }).ok, false);
});
test('8回まちがえるとしばらく止まり、15分たつと戻る', () => {
  let r;
  for (let i = 0; i < 8; i++) r = w.post({ action: 'login', id: 'K003', password: 'bad' + i });
  assert.strictEqual(r.error, 'bad_credentials');
  r = w.post({ action: 'login', id: 'K003', password: people[2][1] });
  assert.strictEqual(r.error, 'locked', '正しいパスワードでも止まっているはず');
  clock += 16 * 60 * 1000;
  r = w.post({ action: 'login', id: 'K003', password: people[2][1] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
test('「停止」にした参加者はログインできない', () => {
  w.ss.getSheetByName('参加者').getRange(5, 3).setValue('停止');     // K004
  const r = w.post({ action: 'login', id: 'K004', password: people[3][1] });
  assert.strictEqual(r.error, 'disabled');
});

console.log('調査項目');
let boot;
test('項目と歩、進み具合を受け取れる', () => {
  boot = w.post({ action: 'bootstrap', token });
  assert.strictEqual(boot.ok, true, JSON.stringify(boot));
  assert.ok(boot.items.length >= 3);
  assert.deepStrictEqual(Object.keys(boot.progress), []);
  assert.ok(boot.settings.instruction.indexOf('自然な方言') >= 0);
  assert.strictEqual(boot.settings.maxRecordSec, 30);
  const total = boot.steps.reduce((n, s) => n + s.count, 0);
  assert.strictEqual(total, boot.items.length);
  const sent = boot.items.find(i => i.type === '例文');
  assert.ok(sent.segments.length >= 2);
});
test('「出す」を FALSE にした項目・重複した設問IDは渡さない', () => {
  const sh = w.ss.getSheetByName('項目');
  const n0 = boot.items.length;
  sh.appendRow([9, 1, 'X001', '例文', 'これは出さない。', '', '', 'これは｜出さない', '', false, '', '']);
  sh.appendRow([9, 2, boot.items[0].id, '語彙', '重複', '', '', '', '', true, '', '']);
  sh.appendRow([9, 3, 'X003', '', '種別なしで文節あり。', '', '', '種別なしで|文節あり', '', '', '', '']);
  const b = w.post({ action: 'bootstrap', token });
  assert.strictEqual(b.items.length, n0 + 1);
  assert.strictEqual(b.items[b.items.length - 1].type, '例文');
  assert.deepStrictEqual(Array.from(b.items[b.items.length - 1].segments), ['種別なしで', '文節あり']);
  assert.strictEqual(b.steps[b.steps.length - 1].no, 9);
});
test('にせの印（トークン）・期限切れは受けつけない', () => {
  assert.strictEqual(w.post({ action: 'bootstrap', token: token.slice(0, -3) + 'abc' }).error, 'auth');
  assert.strictEqual(w.post({ action: 'bootstrap', token: '' }).error, 'auth');
  const parts = token.split('.');
  const forged = [parts[0], Buffer.from('K002').toString('base64'), parts[2], parts[3]].join('.');
  assert.strictEqual(w.post({ action: 'bootstrap', token: forged }).error, 'auth');
  const keep = clock; clock += 31 * 86400000;
  assert.strictEqual(w.post({ action: 'bootstrap', token }).error, 'auth');
  clock = keep;
});

console.log('回答の保存');
const sub = (over) => Object.assign({
  sid: 'sid-' + Math.random().toString(36).slice(2, 12), itemId: 'S002', step: 1, type: '例文', prompt: '頭が痛い。',
  status: '回答済', answer: 'びんたが いて', segPrompt: '頭が｜痛い', segAnswer: 'びんたが｜いて', exampleAnswer: '', note: '',
  noAudioReason: '', elapsedSec: 12.3456, device: 'test', clientTime: new Date(clock).toISOString(), app: '0.1.0',
  audio: [{ slot: 'main', b64: wav(1.5), sampleRate: 48000, durationSec: 1.5, peak: 0.25 }]
}, over || {});
let first;
test('回答が1行追記され、録音が参加者のフォルダに入る', () => {
  first = sub();
  const r = w.post({ action: 'save', token, submission: first });
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.saved, true); assert.strictEqual(r.audio, 1);
  const rows = w.sheetRows('回答');
  assert.strictEqual(rows.length, 2);
  const row = rows[1];
  assert.ok(row[0] instanceof Date);
  assert.strictEqual(row[1], 'K001'); assert.strictEqual(row[3], 'S002'); assert.strictEqual(row[6], '回答済');
  assert.strictEqual(row[7], 'びんたが いて'); assert.strictEqual(row[9], 'びんたが｜いて');
  assert.ok(/^K001_S002_kaitou_\d{8}-\d{6}_sid-/.test(row[12]), row[12]);
  assert.ok(/^https:\/\/drive/.test(row[13]));
  assert.strictEqual(row[17], 1.5); assert.strictEqual(row[18], 48000); assert.strictEqual(row[19], 12.346);
  assert.strictEqual(row[22], first.sid);
  const files = w.files();
  assert.strictEqual(files.length, 1);
  assert.ok(/\/K001\/K001_S002_kaitou_/.test(files[0].path), files[0].path);
  assert.strictEqual(files[0].bytes, 44 + 1.5 * 48000 * 2);
});
test('同じ回答を送り直しても、行も録音も増えない', () => {
  const r = w.post({ action: 'save', token, submission: first });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.duplicate, true);
  for (const k of Object.keys(w.cache)) if (k.indexOf('sid:') === 0) delete w.cache[k];   // キャッシュが消えたあとでも
  const r2 = w.post({ action: 'save', token, submission: first });
  assert.strictEqual(r2.duplicate, true);
  assert.strictEqual(w.sheetRows('回答').length, 2); assert.strictEqual(w.files().length, 1);
});
test('語彙＋提案例文は録音が2本入る', () => {
  const s = sub({ itemId: 'S003', type: '語彙', prompt: '目', answer: 'め', segPrompt: '', segAnswer: '', exampleAnswer: 'めが ふとか',
    audio: [{ slot: 'main', b64: wav(0.8, 44100), sampleRate: 44100, durationSec: 0.8, peak: 0.3 }, { slot: 'example', b64: wav(2), sampleRate: 44100, durationSec: 2, peak: 0.3 }] });
  const r = w.post({ action: 'save', token, submission: s });
  assert.strictEqual(r.audio, 2);
  const row = w.sheetRows('回答').pop();
  assert.ok(/_kaitou_/.test(row[12])); assert.ok(/_reibun_/.test(row[14])); assert.strictEqual(row[10], 'めが ふとか'); assert.strictEqual(row[18], 44100);
  assert.strictEqual(w.files().length, 3);
});
test('「知らない」などは録音なしで保存できる', () => {
  const r = w.post({ action: 'save', token, submission: sub({ itemId: 'S001', status: '知らない', answer: '', segAnswer: '', audio: [], noAudioReason: '回答なし' }) });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.audio, 0);
  const row = w.sheetRows('回答').pop();
  assert.strictEqual(row[6], '知らない'); assert.strictEqual(row[12], ''); assert.strictEqual(row[17], '');
});
test('数式のような回答が数式として入らない', () => {
  const before = w.ss.sheets.reduce((n, s) => n + s.formulas.length, 0);
  w.post({ action: 'save', token, submission: sub({ itemId: 'S004', answer: '=IMPORTRANGE("x","y")', note: '+1+1', segAnswer: '@a', exampleAnswer: '-2', device: '=1', audio: [] }) });
  const row = w.sheetRows('回答').pop();
  assert.strictEqual(row[7], '=IMPORTRANGE("x","y")'); assert.strictEqual(row[11], '+1+1');
  assert.strictEqual(w.ss.sheets.reduce((n, s) => n + s.formulas.length, 0), before, '数式として入ってしまった');
  assert.ok(!w.sheetRows('回答').some(r => r.indexOf('#FORMULA!') >= 0));
});
test('数字だけの回答・送信IDが文字のまま残る', () => {
  const s = sub({ sid: '1234567890', itemId: 'S005', answer: '0123', audio: [] });
  w.post({ action: 'save', token, submission: s });
  const row = w.sheetRows('回答').pop();
  assert.strictEqual(row[7], '0123'); assert.strictEqual(row[22], '1234567890');
  assert.strictEqual(w.post({ action: 'save', token, submission: s }).duplicate, true);
});
test('こわれた録音・長すぎる文字・おかしな送信IDをはじく／切る', () => {
  assert.strictEqual(w.post({ action: 'save', token, submission: sub({ audio: [{ slot: 'main', b64: Buffer.from('not a wav file at all, definitely not').toString('base64') }] }) }).error, 'bad_request');
  assert.strictEqual(w.post({ action: 'save', token, submission: sub({ sid: 'x' }) }).error, 'bad_request');
  assert.strictEqual(w.post({ action: 'save', token, submission: sub({ sid: '../../etc' }) }).error, 'bad_request');
  assert.strictEqual(w.post({ action: 'save', token }).error, 'bad_request');
  const n = w.sheetRows('回答').length;
  w.post({ action: 'save', token, submission: sub({ answer: 'あ'.repeat(5000), audio: [] }) });
  assert.strictEqual(w.sheetRows('回答').length, n + 1);
  assert.strictEqual(w.sheetRows('回答').pop()[7].length, 600);
});
test('保存先がこみあったら「busy」、送り直すと1回だけ保存される', () => {
  const s = sub({ itemId: 'S002' });
  const rows = w.sheetRows('回答').length, files = w.files().length;
  w.control.lockBusy = 1;
  // 1回目：フォルダはもうあるので、追記の直前のロックで失敗する
  const r1 = w.post({ action: 'save', token, submission: s });
  assert.strictEqual(r1.error, 'busy', JSON.stringify(r1));
  assert.strictEqual(w.sheetRows('回答').length, rows);
  const r2 = w.post({ action: 'save', token, submission: s });
  assert.strictEqual(r2.saved, true);
  assert.strictEqual(w.sheetRows('回答').length, rows + 1);
  assert.strictEqual(w.files().length, files + 1, '録音が2重に作られた');
});
test('追記に失敗しても、送り直せば録音は1本のまま保存される', () => {
  const s = sub({ itemId: 'S004' });
  const rows = w.sheetRows('回答').length, files = w.files().length;
  w.control.failAppend = 1;
  assert.strictEqual(w.post({ action: 'save', token, submission: s }).error, 'server_error');
  assert.strictEqual(w.post({ action: 'save', token, submission: s }).saved, true);
  assert.strictEqual(w.sheetRows('回答').length, rows + 1);
  assert.strictEqual(w.files().length, files + 1);
});
test('ほかの参加者の回答は別のフォルダ・別の進み具合になる', () => {
  const t2 = w.post({ action: 'login', id: 'K002', password: people[1][1] }).token;
  w.post({ action: 'save', token: t2, submission: sub({ itemId: 'S001', type: '語彙', prompt: '頭', answer: 'びんた', segPrompt: '', segAnswer: '' }) });
  assert.ok(w.files().some(f => /\/K002\/K002_S001_kaitou_/.test(f.path)));
  const p2 = w.post({ action: 'bootstrap', token: t2 }).progress;
  assert.deepStrictEqual(Object.keys(p2), ['S001']);
  const p1 = w.post({ action: 'bootstrap', token }).progress;
  assert.ok(p1.S002 && p1.S002.count === 3 && p1.S002.status === '回答済', JSON.stringify(p1.S002));
  assert.strictEqual(p1.S001.status, '知らない');
});
test('受付を「停止中」にすると、ログインも送信もできない', () => {
  const sh = w.ss.getSheetByName('設定');
  sh.getRange(2, 2).setValue('停止中');
  assert.strictEqual(w.post({ action: 'login', id: 'K001', password: people[0][1] }).error, 'closed');
  assert.strictEqual(w.post({ action: 'save', token, submission: sub() }).error, 'closed');
  sh.getRange(2, 2).setValue('受付中');
  assert.strictEqual(w.post({ action: 'bootstrap', token }).ok, true);
});
test('途中で「停止」にした参加者は、2分以内に送信できなくなる', () => {
  const t5 = w.post({ action: 'login', id: 'K005', password: people[4][1] }).token;
  assert.strictEqual(w.post({ action: 'bootstrap', token: t5 }).ok, true);
  w.ss.getSheetByName('参加者').getRange(6, 3).setValue('停止');
  clock += 121 * 1000;
  assert.strictEqual(w.post({ action: 'bootstrap', token: t5 }).error, 'disabled');
});
test('読めない内容・知らない操作にはエラーで答える（落ちない）', () => {
  assert.strictEqual(w.post('これはJSONではない').error, 'bad_request');
  assert.strictEqual(w.post({ action: 'drop_table' }).error, 'bad_request');
  assert.strictEqual(w.post('null').error, 'bad_request');
});

console.log('集計');
test('進み具合シートが作られる', () => {
  const n = w.call('refreshProgress');
  const rows = w.sheetRows('進み具合');
  assert.strictEqual(rows.length, n + 1);
  const k1 = rows.find(r => r[0] === 'K001');
  assert.ok(k1[1] >= 4, '回答した設問数: ' + k1[1]);
  assert.strictEqual(k1[2], w.post({ action: 'bootstrap', token }).items.length);
  assert.strictEqual(k1[4], 1);
  assert.ok(k1[6] instanceof Date);
  const k3 = rows.find(r => r[0] === 'K003');
  assert.strictEqual(k3[1], 0);
});
test('メニューが落ちずに動く', () => {
  w.call('onOpen'); w.call('menuSetup'); w.ui._promptAnswer = '２'; w.call('menuAddParticipants'); w.call('menuRefreshProgress'); w.call('menuOpenAudioFolder');
  assert.ok(w.sheetRows('参加者').some(r => r[0] === 'K902'), '全角の「２」で2人追加されるはず');
});

Date.now = realNow;
console.log(`\n${passed} 件のテストに合格` + (process.exitCode ? '（失敗あり）' : ''));
