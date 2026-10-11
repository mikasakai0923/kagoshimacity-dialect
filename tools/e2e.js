#!/usr/bin/env node
/*
 * 開発用：サイトを本物のブラウザで動かして、最初から最後まで確かめる自動テスト。
 * Google 側は tools/mock-gas.js（まねサーバー）を使います。
 *
 *   node tools/e2e.js [gas/Code.gs] [--shots フォルダ]
 *
 * Playwright（Chromium）が必要です。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const { startStatic } = require('./serve');
const { createGasWorld, startServer } = require('./mock-gas');

const args = process.argv.slice(2);
const shotsIdx = args.indexOf('--shots');
const shots = shotsIdx >= 0 ? path.resolve(args[shotsIdx + 1]) : null;
const codeArg = args.find((a, i) => !a.startsWith('--') && (shotsIdx < 0 || i !== shotsIdx + 1));
const code = path.resolve(codeArg || path.join(__dirname, '..', 'gas', 'Code.gs'));
const SITE = 8765, API = 8766;
const root = path.resolve(__dirname, '..');
const site = `http://localhost:${SITE}`;
const apiPattern = `http://localhost:${API}/**`;
const FAKE_MIC = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

let failed = 0, passed = 0;
const only = process.env.E2E_ONLY || '';       // 名前にこの文字をふくむテストだけを動かす（ほかの結果に頼らないテスト向け）
async function test(name, fn) {
  if (only && name.indexOf(only) < 0) return;
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) {
    failed++;
    console.error('  NG  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      '));
    if (shots && test.page) { try { fs.mkdirSync(shots, { recursive: true }); await test.page.screenshot({ path: path.join(shots, 'NG-' + failed + '.png'), fullPage: true }); } catch (e2) { /* 何もしない */ } }
  }
}

// マイクの「にせの音」に使うWAV（48kHz・モノラル・16ビット）。amp が 0 なら無音
function makeWav(file, seconds, amp) {
  const rate = 48000, n = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * amp * 32767), 44 + i * 2);
  fs.writeFileSync(file, b);
  return file;
}
// 声に似せた「にせの音」：0.22秒の音と0.18秒の切れ目をくり返す。noiseAmp はまわりの雑音の大きさ（0 なら静かな部屋）
function makeSpeechWav(file, noiseAmp) {
  const rate = 48000, period = Math.round(rate * 0.4), on = Math.round(rate * 0.22), n = period * 10;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    const k = i % period;
    const env = k < on ? Math.min(1, k / 480, (on - k) / 960) : 0;
    const noise = (rnd() + rnd() + rnd() + rnd() - 2) * 1.732 * noiseAmp;          // ほぼ正規分布（大きさ noiseAmp）
    const v = Math.max(-1, Math.min(1, env * 0.3 * Math.sin(i * 2 * Math.PI * 220 / rate) + noise));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, b);
  return file;
}
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const world = createGasWorld(code);
  world.call('setup');
  world.call('addParticipants', 8);
  const people = world.sheetRows('参加者').slice(1).map(r => ({ id: r[0], pw: r[1] }));
  const apiServer = await startServer(world, API);
  const siteServer = await startStatic(root, SITE);
  const browser = await chromium.launch({ args: FAKE_MIC });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-e2e-'));

  const errors = [];
  // config.js を、テスト用の保存先に向ける。guard を指定しないかぎり、押しまちがい防止の待ち時間は 0 にする
  async function prepare(page, opt) {
    await page.route('**/config.js*', async route => {
      const res = await route.fetch();
      let body = (await res.text()).replace('apiUrl: ""', `apiUrl: "http://localhost:${API}/exec"`);
      if (!(opt && opt.guard)) body = body.replace('window.KS_CONFIG = {', 'window.KS_CONFIG = { tapGuardMs: 0,');
      await route.fulfill({ response: res, body });
    });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
    return page;
  }
  async function newPage(opt, b) {
    opt = opt || {};
    const ctx = await (b || browser).newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'], locale: 'ja-JP' }, opt.context || {}));
    if (opt.init) await ctx.addInitScript(opt.init);
    return prepare(await ctx.newPage(), opt);
  }
  const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true }); } };
  const rows = () => world.sheetRows('回答').slice(1);
  const rowsOf = id => rows().filter(r => r[1] === id);
  const untilRows = async (n, ms) => { const t0 = Date.now(); while (rows().length < n) { if (Date.now() - t0 > (ms || 15000)) throw new Error(`回答が ${n} 行になりません（いま ${rows().length} 行）`); await new Promise(r => setTimeout(r, 100)); } };
  const until = async (fn, what, ms) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > (ms || 15000)) throw new Error('待っても変わりません：' + what); await new Promise(r => setTimeout(r, 100)); } };
  const recState = (page, i) => page.locator('.rec').nth(i || 0).getAttribute('data-state');
  async function record(page, nth, ms) {
    const rec = page.locator('.rec').nth(nth || 0);
    await rec.locator('.rec__btn').click();
    await page.waitForFunction(i => document.querySelectorAll('.rec')[i].getAttribute('data-state') === 'recording', nth || 0, { timeout: 10000 });
    await page.waitForTimeout(ms || 900);
    await rec.locator('.rec__btn').click();
    await page.waitForFunction(i => document.querySelectorAll('.rec')[i].getAttribute('data-state') === 'done', nth || 0, { timeout: 10000 });
  }
  async function login(page, who, pw) {
    await page.goto(`${site}/#/login`);
    await page.waitForSelector('#login-id');
    await page.fill('#login-id', who.id);
    await page.fill('#login-pw', pw === undefined ? who.pw : pw);
    await page.click('button[type=submit]');
  }
  async function practice(page) {
    await page.click('.tile--here');
    await page.waitForSelector('.page--practice');
    await record(page, 0, 700);
    await page.getByRole('button', { name: '地図へすすむ' }).click();
    await page.waitForSelector('.board .tile--here');
  }
  async function openStep(page) {
    await page.click('.tile--here');
    await page.click('.dialog .btn--primary');
  }
  const pill = page => page.locator('.pill').first().innerText();
  const hash = page => new URL(page.url()).hash;

  const page = await newPage();
  test.page = page;
  console.log('ログイン');
  await test('紹介ページが出て、本番の設定ではお試しの表示が出ない', async () => {
    await page.goto(`${site}/`);
    await page.waitForSelector('.hero__title');
    assert.strictEqual(await page.locator('.demo-banner').count(), 0);
    assert.strictEqual(await page.locator('.notice--bad').count(), 0);
    await shot(page, 'live-01-intro');
  });
  await test('まちがったパスワードでは入れず、理由が出る', async () => {
    await login(page, people[0], '999999x');
    await page.waitForFunction(() => document.querySelector('.form-error').textContent.length > 0);
    assert.ok(/ちがいます/.test(await page.locator('.form-error').innerText()));
    assert.ok(/#\/login/.test(page.url()));
  });
  await test('ナンバーの欄で Enter を押すと、パスワードの欄へ移る（まだ送らない）', async () => {
    await page.fill('#login-id', people[0].id);
    await page.fill('#login-pw', '');
    await page.focus('#login-id');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'login-pw');
    assert.ok(/#\/login/.test(page.url()));
  });
  await test('全角で入力してもログインできて、地図が出る', async () => {
    const zen = s => s.replace(/[0-9A-Za-z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
    await page.fill('#login-id', zen(people[0].id.toLowerCase()));
    await page.fill('#login-pw', zen(people[0].pw));
    await page.click('button[type=submit]');
    await page.waitForSelector('.board .tile');
    assert.ok((await page.locator('.who').innerText()).indexOf(people[0].id) === 0);
    assert.strictEqual(await page.locator('.tile').count(), 4);       // ふりだし＋2歩＋あがり
    assert.ok(/送信ずみ/.test(await pill(page)));
  });
  await test('ログインのあと「戻る」を押すと、ログイン画面ではなく紹介ページにもどる', async () => {
    await page.goBack();
    await page.waitForSelector('.hero__title');
    await page.click('text=つづきから歩く');
    await page.waitForSelector('.board .tile');
    assert.strictEqual(hash(page), '#/map');
  });

  console.log('れんしゅう → 1歩目');
  await test('れんしゅうの前は、歩に進めない', async () => {
    await page.goto(`${site}/#/step/1`);
    await page.waitForSelector('.page--practice');
    assert.strictEqual(hash(page), '#/practice');
  });
  await test('録音のとちゅうで画面が隠れたら（電話がかかってきた など）、その録音は使わずに録り直してもらう', async () => {
    await page.locator('.rec__btn').click();
    await page.waitForFunction(() => document.querySelector('.rec').getAttribute('data-state') === 'recording', null, { timeout: 10000 });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.strictEqual(await recState(page, 0), 'idle');
    assert.ok(/とちゅうで止まりました/.test(await page.locator('.rec__note').innerText()));
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    assert.strictEqual(await page.locator('.practice__check').count(), 0);
  });
  await test('録音のれんしゅう：音の大きさで「録音できています」と確かめて、地図へ進む', async () => {
    await record(page, 0, 700);
    assert.ok(/声は録音できています/.test(await page.locator('.practice__after').innerText()));
    await shot(page, 'live-02-practice');
    await page.click('text=聞く');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '地図へすすむ' }).click();
    await page.waitForSelector('.board .tile--here');
    assert.ok(/1歩目/.test(await page.locator('.tile--here').getAttribute('aria-label')));
    assert.strictEqual(rows().length, 0, 'れんしゅうの録音は送られないはず');
  });
  await test('ひらがな以外には知らせが出る。かな漢字変換のとちゅうでは出ない', async () => {
    await openStep(page);
    await page.waitForSelector('#f-answer');
    await page.fill('#f-answer', 'atama');
    assert.ok(/ひらがなで書いてください/.test(await page.locator('.field__warn').first().innerText()));
    await page.fill('#f-answer', '');
    assert.strictEqual(await page.locator('.field__warn').first().innerText(), '');
    const warnAfter = await page.evaluate(() => {
      const i = document.querySelector('#f-answer'), w = document.querySelector('.field__warn');
      const out = [];
      i.dispatchEvent(new CompositionEvent('compositionstart'));
      i.value = 'ｂ'; i.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); out.push(w.textContent);   // ローマ字入力のとちゅう
      i.value = 'び'; i.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); out.push(w.textContent);
      i.dispatchEvent(new CompositionEvent('compositionend')); out.push(w.textContent);
      i.dispatchEvent(new CompositionEvent('compositionstart'));
      i.value = '頭'; i.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); out.push(w.textContent);
      i.dispatchEvent(new CompositionEvent('compositionend')); out.push(w.textContent ? 'warn' : '');
      i.value = ''; i.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return out;
    });
    assert.deepStrictEqual(warnAfter, ['', '', '', '', 'warn']);
  });
  await test('語彙：書かずに進めない／録音なしで進めない／書いて録音すると進める', async () => {
    await page.click('text=つぎへ');
    assert.ok(/回答をひらがなで/.test(await page.locator('.form-error').innerText()));
    await page.fill('#f-answer', 'びんた');
    await page.click('text=つぎへ');
    assert.ok(/録音がまだ/.test(await page.locator('.form-error').innerText()));
    await record(page, 0, 1000);
    await page.fill('#f-note', '=1+1 あたまともいう');
    await shot(page, 'live-03-word');
    await page.click('text=つぎへ');
    await page.waitForSelector('.segs');
    await untilRows(1);
    const r = rows()[0];
    assert.strictEqual(r[1], people[0].id); assert.strictEqual(r[3], 'S001'); assert.strictEqual(r[4], '語彙'); assert.strictEqual(r[5], '頭');
    assert.strictEqual(r[6], '回答済'); assert.strictEqual(r[7], 'びんた'); assert.strictEqual(r[11], '=1+1 あたまともいう');
    assert.ok(/_S001_kaitou_/.test(r[12])); assert.ok(r[17] >= 0.8 && r[17] <= 2.5, '録音の長さ ' + r[17]);
    assert.ok(r[18] === 48000 || r[18] === 44100, 'サンプリング周波数 ' + r[18]);
    assert.ok(r[19] > 0); assert.ok(/Chrome/.test(r[20]));
    assert.ok(/^[0-9a-f-]{36}$/.test(r[22]), '送信ID ' + r[22]);
    const info = JSON.parse(r[23]);
    assert.strictEqual(info.main.ec, false); assert.ok(info.main.peak > 0.01);
  });
  await test('録音は正しいWAV（16ビット・モノラル）として保存される', async () => {
    const f = world.files()[0];
    const b = world.fileBytes(f.id);
    assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(b.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(b.readUInt16LE(20), 1); assert.strictEqual(b.readUInt16LE(22), 1); assert.strictEqual(b.readUInt16LE(34), 16);
    const rate = b.readUInt32LE(24), dataLen = b.readUInt32LE(40);
    assert.strictEqual(dataLen, b.length - 44); assert.strictEqual(b.readUInt32LE(4), b.length - 8);
    const sec = dataLen / 2 / rate;
    assert.ok(sec > 0.8 && sec < 2.5, '長さ ' + sec);
    let peak = 0; for (let i = 44; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
    assert.ok(peak > 500, '無音になっている（最大 ' + peak + '）');
    if (shots) fs.writeFileSync(path.join(shots, 'sample.wav'), b);
  });
  await test('例文：Enter で次の文節へ移る。文節の一部が空欄なら確かめてから進む。文節ごとの回答が保存される', async () => {
    await page.fill('#f-seg-0', 'びんたが');
    await page.focus('#f-seg-0');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'f-seg-1');
    await page.keyboard.press('Enter');      // 最後の文節では、キーボードをしまう（どこにも送らない）
    assert.notStrictEqual(await page.evaluate(() => document.activeElement.id), 'f-seg-1');
    assert.strictEqual(rows().length, 1);
    await record(page, 0, 800);
    await page.click('text=つぎへ');
    await page.waitForSelector('.dialog');
    assert.ok(/書いていない文節/.test(await page.locator('.dialog__title').innerText()));
    await page.click('text=もどって書く');
    await page.fill('#f-seg-1', 'いて');
    await page.fill('#f-note', 'びんたがうずく');
    await shot(page, 'live-04-sentence');
    await page.click('text=つぎへ');
    await page.waitForSelector('#f-example');
    await untilRows(2);
    const r = rows()[1];
    assert.strictEqual(r[3], 'S002'); assert.strictEqual(r[7], 'びんたが いて'); assert.strictEqual(r[8], '頭が｜痛い'); assert.strictEqual(r[9], 'びんたが｜いて');
    assert.strictEqual(r[11], 'びんたがうずく');
  });
  await test('語彙＋提案例文：録音が2本保存される。クリアの画面は、送信が終わるまで「閉じないで」と知らせる', async () => {
    await page.fill('#f-answer', 'め');
    // 1つめの録音中に2つめのボタンを押すと、1つめを終えるだけ（マイクを2つ同時には開かない）
    await page.locator('.rec').nth(0).locator('.rec__btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.rec')[0].getAttribute('data-state') === 'recording', null, { timeout: 10000 });
    await page.waitForTimeout(700);
    await page.locator('.rec').nth(1).locator('.rec__btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.rec')[0].getAttribute('data-state') === 'done', null, { timeout: 10000 });
    assert.strictEqual(await recState(page, 1), 'idle');
    assert.ok(/さきほどの録音を終えました/.test(await page.locator('.rec').nth(1).locator('.rec__note').innerText()));
    await page.fill('#f-example', 'めが ふとか');
    await page.click('text=この歩をおえる');
    assert.ok(/例文の録音がまだ/.test(await page.locator('.form-error').innerText()));
    await record(page, 1, 900);
    world.control.delayMs = 1500;           // 保存先の返事をおくらせて、「送信中」の表示を確かめる
    await page.click('text=この歩をおえる');
    await page.waitForSelector('.clear__title');
    assert.strictEqual(hash(page), '#/clear/1');
    assert.ok(/送信しています[\s\S]*閉じないでください/.test(await page.locator('.sendbox').innerText()), await page.locator('.sendbox').innerText());
    await shot(page, 'live-05-clear-sending');
    await untilRows(3);
    world.control.delayMs = 0;
    const r = rows()[2];
    assert.ok(/_kaitou_/.test(r[12]) && /_reibun_/.test(r[14])); assert.strictEqual(r[10], 'めが ふとか');
    assert.strictEqual(world.files().length, 4);
    await page.waitForFunction(() => /送信ずみ/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    assert.ok(/すべて送信されました/.test(await page.locator('.sendbox').innerText()));
    await shot(page, 'live-06-clear');
  });

  console.log('つづき・やり直し');
  await test('読みこみ直しても、ログインと進み具合が残っている', async () => {
    await page.goto(`${site}/`);
    await page.waitForSelector('text=つづきから歩く');
    await page.click('text=つづきから歩く');
    await page.waitForSelector('.board .tile--here');
    assert.ok(/2歩目/.test(await page.locator('.tile--here').getAttribute('aria-label')));
    assert.strictEqual(await page.locator('.tile--done').count(), 2);
    await shot(page, 'live-07-map');
  });
  await test('歩きおえた歩のアドレスを開いても、地図にもどる', async () => {
    await page.goto(`${site}/#/step/1`);
    await page.waitForSelector('.board .tile');
    assert.strictEqual(hash(page), '#/map');
  });
  await test('通信が切れているあいだの回答は端末に残り、つながると送られる', async () => {
    await openStep(page);
    await page.waitForSelector('#f-seg-0');
    await page.route(apiPattern, r => r.abort());
    await page.fill('#f-seg-0', 'あめが'); await page.fill('#f-seg-1', 'ふっちょっ');
    await record(page, 0, 700);
    await page.click('text=つぎへ');
    await page.waitForSelector('#f-seg-2');
    await page.waitForTimeout(800);
    assert.strictEqual(rows().length, 3);
    await page.goto(`${site}/#/map`);
    await page.reload();
    await page.waitForSelector('.board .tile');
    await page.waitForFunction(() => /未送信 1件/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    assert.ok(/のこり 1問/.test(await page.locator('.tile--here').getAttribute('aria-label')), '未送信の回答も「答えた」あつかいのはず');
    await page.waitForSelector('.notice--warn');
    assert.ok(/まだ送られていない回答が 1件/.test(await page.locator('.notice--warn').innerText()));
    await shot(page, 'live-08-unsent');
    await page.unroute(apiPattern);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await untilRows(4, 20000);
    await page.waitForFunction(() => /送信ずみ/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    assert.strictEqual(rows()[3][3], 'S004'); assert.strictEqual(rows()[3][9], 'あめが｜ふっちょっ');
    assert.strictEqual(world.files().length, 5);
    assert.strictEqual(await page.locator('.notice--warn').count(), 0);
  });
  await test('「使わない」は録音なしで記録される', async () => {
    await openStep(page);
    await page.waitForSelector('#f-seg-0');
    await page.click('text=知らない・使わない・思い出せないとき');
    await page.click('text=使わない（聞いたことはあるが');
    await page.fill('#f-note', 'ねこはおらん');
    await page.click('text=この歩をおえる');
    await page.waitForSelector('.clear__title');
    await untilRows(5);
    const r = rows()[4];
    assert.strictEqual(r[6], '使わない'); assert.strictEqual(r[7], ''); assert.strictEqual(r[12], ''); assert.strictEqual(r[11], 'ねこはおらん');
    assert.ok(/あがり/.test(await page.locator('.clear__title').innerText()));
    await shot(page, 'live-09-goal');
  });
  await test('「もう一度こたえる」と行が増える。「録音なし」はその歩のあいだだけ。回答は書かれたとおりに保存される', async () => {
    await page.click('text=地図にもどる');
    await page.waitForSelector('.board .tile');
    await page.locator('.tile--done').nth(2).click();
    await page.getByRole('button', { name: 'もう一度こたえる' }).click();
    await page.waitForSelector('#f-seg-0');
    await page.click('text=マイクが使えないとき');
    await page.getByRole('button', { name: '録音なしで進む' }).click();
    await page.waitForSelector('.rec--off');
    await page.fill('#f-seg-0', 'あめん'); await page.fill('#f-seg-1', 'ふっちょっど');
    await page.fill('#f-note', 'か゜ ｶｷ　１');          // 全角・半角や「か゜」を、勝手に変えない
    await page.click('text=つぎへ');
    await untilRows(6);
    const r = rows()[5];
    assert.strictEqual(r[3], 'S004'); assert.strictEqual(r[16], 'マイクが使えない'); assert.strictEqual(r[12], '');
    assert.strictEqual(r[11], 'か゜ ｶｷ　１');
    await page.waitForSelector('#f-seg-2');
    assert.strictEqual(await page.locator('.rec--off').count(), 1, '同じ歩のあいだは録音なしのまま');
    await page.click('.iconbtn[aria-label="地図にもどる"]');
    await page.waitForSelector('.board .tile');
    // 開き直すと、また録音をためしてもらう
    await page.locator('.tile--done').nth(2).click();
    await page.getByRole('button', { name: 'もう一度こたえる' }).click();
    await page.waitForSelector('#f-seg-0');
    assert.strictEqual(await page.locator('.rec--off').count(), 0);
    assert.strictEqual(await page.locator('.rec__btn').count(), 1);
  });

  console.log('ログインの期限・別の参加者');
  await test('ログインの期限が切れても回答は残り、ログインし直すと送られる', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ks1:session')); s.token = s.token.slice(0, -4) + 'AAAA'; localStorage.setItem('ks1:session', JSON.stringify(s)); KS.state.session.token = s.token; });
    await page.fill('#f-seg-0', 'あめが'); await page.fill('#f-seg-1', 'ふいよっ');
    await record(page, 0, 700);
    await page.click('text=つぎへ');
    await page.waitForSelector('.dialog');
    assert.ok(/もう一度ログイン/.test(await page.locator('.dialog__title').innerText()));
    assert.strictEqual(rows().length, 6);
    await page.click('.dialog .btn--primary');
    await page.waitForSelector('#login-pw');
    await page.fill('#login-pw', people[0].pw);
    await page.click('button[type=submit]');
    await page.waitForSelector('.board .tile');
    await untilRows(7, 20000);
    assert.strictEqual(rows()[6][9], 'あめが｜ふいよっ');
  });
  await test('ログアウトして別の参加者で入ると、その人の進み具合になる', async () => {
    await page.waitForFunction(() => /送信ずみ/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    await page.click('.iconbtn[aria-label="メニュー"]');
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await page.waitForFunction(() => /ログアウトしますか/.test((document.querySelector('.dialog__title') || {}).textContent || ''));
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await page.waitForSelector('.hero__title');
    await login(page, people[1]);
    await page.waitForSelector('.board .tile');
    assert.ok((await page.locator('.who').innerText()).indexOf(people[1].id) === 0);
    assert.ok(/ふりだし/.test(await page.locator('.tile--here').getAttribute('aria-label')));
    assert.strictEqual(await page.locator('.tile--done').count(), 0);
  });
  await test('受付を止めると、ログインできず理由が出る', async () => {
    await page.click('.iconbtn[aria-label="メニュー"]');
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await page.waitForFunction(() => /ログアウトしますか/.test((document.querySelector('.dialog__title') || {}).textContent || ''));
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    world.ss.getSheetByName('設定').getRange(2, 2).setValue('停止中');
    await login(page, people[2]);
    await page.waitForFunction(() => document.querySelector('.form-error') && document.querySelector('.form-error').textContent.length > 0);
    assert.ok(/受付を止めて/.test(await page.locator('.form-error').innerText()));
    world.ss.getSheetByName('設定').getRange(2, 2).setValue('受付中');
  });

  console.log('押しまちがい・「戻る」ボタン（押しまちがい防止の待ち時間は、本番と同じ）');
  const gp = await newPage({ guard: true });
  const wait = () => gp.waitForTimeout(500);       // 画面が変わった直後の「押す」は受けつけないので、少し待ってから押す
  await test('マスを2回続けて押しても、確認の窓は開いたまま。少し待てば、ふつうに始められる', async () => {
    test.page = gp;
    await gp.goto(`${site}/#/login`);
    await gp.waitForSelector('#login-id');
    await gp.fill('#login-id', people[3].id); await gp.fill('#login-pw', people[3].pw);
    await wait(); await gp.click('button[type=submit]');
    await gp.waitForSelector('.board .tile');
    await wait(); await gp.click('.tile--here');
    await gp.waitForSelector('.page--practice');
    await wait(); await record(gp, 0, 700);
    await wait(); await gp.getByRole('button', { name: '地図へすすむ' }).click();
    await gp.waitForSelector('.board .tile--here');
    await wait();
    await gp.locator('.tile--here').dblclick({ delay: 40 });
    await gp.waitForTimeout(150);
    assert.strictEqual(await gp.locator('.dialog').count(), 1, '2回目の「押す」で窓が閉じてしまった');
    await wait(); await gp.click('.dialog .btn--primary');
    await gp.waitForSelector('#f-answer');
    assert.strictEqual(hash(gp), '#/step/1');
  });
  await test('「つぎへ」を2回続けて押しても、次の問題は1つだけ進み、何も押されない', async () => {
    await gp.fill('#f-answer', 'びんた');
    await wait(); await record(gp, 0, 700);
    await gp.getByRole('button', { name: 'つぎへ' }).dblclick({ delay: 60 });
    await gp.waitForSelector('.segs');
    await gp.waitForTimeout(600);
    assert.strictEqual(await gp.locator('.progress__count').innerText(), '2 / 3');
    assert.strictEqual(await gp.locator('.form-error').innerText(), '');
    assert.strictEqual(await recState(gp, 0), 'idle');
    await until(() => rowsOf(people[3].id).length === 1, '1問目の保存');
  });
  await test('書きかけのまま「戻る」を押すと確かめる。「つづける」で残り、「はなれる」で地図へ', async () => {
    await gp.fill('#f-seg-0', 'びんたが');
    await gp.goBack();
    await gp.waitForSelector('.dialog');
    assert.ok(/この問題からはなれますか/.test(await gp.locator('.dialog__title').innerText()));
    assert.strictEqual(hash(gp), '#/step/1', '画面とアドレスがずれている');
    await shot(gp, 'live-10-leave');
    await wait(); await gp.getByRole('button', { name: 'つづける' }).click();
    assert.strictEqual(await gp.inputValue('#f-seg-0'), 'びんたが');
    await wait(); await gp.goBack();
    await gp.waitForSelector('.dialog');
    await wait(); await gp.getByRole('button', { name: 'はなれる' }).click();
    await gp.waitForSelector('.board .tile');
    assert.strictEqual(hash(gp), '#/map');
    assert.strictEqual(rowsOf(people[3].id).length, 1);
  });
  await test('書いていなければ、「戻る」でそのまま地図へ。×ボタンは、書きかけなら確かめる', async () => {
    await wait(); await gp.click('.tile--here');
    await wait(); await gp.click('.dialog .btn--primary');
    await gp.waitForSelector('#f-seg-0');
    await gp.goBack();
    await gp.waitForSelector('.board .tile');
    assert.strictEqual(await gp.locator('.dialog').count(), 0);
    await wait(); await gp.click('.tile--here');
    await wait(); await gp.click('.dialog .btn--primary');
    await gp.waitForSelector('#f-seg-0');
    await gp.fill('#f-seg-1', 'いて');
    await wait(); await gp.click('.iconbtn[aria-label="地図にもどる"]');
    await gp.waitForSelector('.dialog');
    assert.ok(/地図にもどりますか/.test(await gp.locator('.dialog__title').innerText()));
    await wait(); await gp.locator('.dialog').getByRole('button', { name: '地図にもどる' }).click();
    await gp.waitForSelector('.board .tile');
    await gp.context().close();
    test.page = page;
  });

  console.log('イラスト');
  await test('「イラスト」欄に https の画像アドレスを書くと、その画像が出る。読みこめない画像は枠ごと消える', async () => {
    const items = world.ss.getSheetByName('項目');
    const url = 'https://img.example.test/pics/atama.png';
    items.getRange(2, 9).setValue(url);
    items.getRange(3, 9).setValue('https://img.example.test/pics/nai.png');
    const p = await newPage();
    test.page = p;
    await p.route('https://img.example.test/**', route => /atama/.test(route.request().url())
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }) : route.fulfill({ status: 404, body: 'x' }));
    await login(p, people[4]);
    await p.waitForSelector('.board .tile');
    await practice(p);
    await openStep(p);
    await p.waitForSelector('#f-answer');
    await p.waitForFunction(() => { const i = document.querySelector('.q__pic img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 });
    assert.strictEqual(await p.locator('.q__pic img').getAttribute('src'), url);
    assert.strictEqual(await p.locator('.q__pic img').count(), 1);
    await p.fill('#f-answer', 'びんた');
    await record(p, 0, 700);
    await p.click('text=つぎへ');
    await p.waitForSelector('.segs');
    await p.waitForFunction(() => { const b = document.querySelector('.q__pic'); return !b || getComputedStyle(b).display === 'none'; }, null, { timeout: 10000 });
    items.getRange(2, 9).setValue('head'); items.getRange(3, 9).setValue('head');
    await until(() => rowsOf(people[4].id).length === 1, '保存');
    await p.context().close();
    test.page = page;
  });

  console.log('端末に保存できないとき');
  await test('端末に回答をとっておけないときは、送信が終わるまで進まない。送り直しても二重にならない', async () => {
    const p = await newPage({ init: () => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); } });
    test.page = p;
    const next = () => p.getByRole('button', { name: /^(つぎへ|この歩をおえる)$/ });
    const waitText = () => p.locator('.q__wait').innerText();
    await login(p, people[5]);
    await p.waitForSelector('.board .tile');
    await practice(p);
    await openStep(p);
    await p.waitForSelector('#f-answer');
    await p.fill('#f-answer', 'びんた');
    await record(p, 0, 700);
    // 1回目：保存先には届くが、返事が端末にもどって来ない（通信がとちゅうで切れた、という場面）
    await p.route(apiPattern, async route => { try { await route.fetch(); } catch (e) { /* 何もしない */ } await route.abort(); });
    await next().click();
    await p.waitForFunction(() => /まだ送信できていません/.test(document.querySelector('.q__wait').textContent), null, { timeout: 15000 });
    assert.strictEqual(await p.locator('#f-answer').count(), 1, '送信できていないのに、次の問題へ進んでしまった');
    assert.strictEqual(await p.inputValue('#f-answer'), 'びんた');
    assert.strictEqual(await p.locator('#f-answer').getAttribute('readonly'), '', '待っているあいだは書きかえられないはず');
    assert.ok(await next().isDisabled());
    assert.strictEqual(rowsOf(people[5].id).length, 1, '保存先には届いているはず');
    assert.strictEqual(await p.evaluate(() => KS.sync.status().volatile), 1);
    await shot(p, 'live-11-volatile');
    // 通信がもどると、自動の送り直し（または「いま送り直す」）で次へ進む。保存先の行は増えない
    await p.unroute(apiPattern);
    await p.getByRole('button', { name: 'いま送り直す' }).click();
    await p.waitForSelector('.segs', { timeout: 15000 });
    assert.ok(/この端末には回答をとっておけない/.test(await p.locator('.q .notice--bad').innerText()));
    await p.waitForFunction(() => { const st = KS.sync.status(); return st.pending === 0 && st.volatile === 0; }, null, { timeout: 15000 });
    assert.strictEqual(rowsOf(people[5].id).length, 1, '同じ回答が二重に保存された');
    assert.strictEqual(world.files().filter(f => f.path.indexOf('/' + people[5].id + '_') >= 0).length, 1, '録音が二重に保存された');
    // 通信できないあいだは、回答は画面に残ったまま。つながると、何も押さなくても自動で送られて進む
    await p.route(apiPattern, r => r.abort());
    await p.fill('#f-seg-0', 'びんたが'); await p.fill('#f-seg-1', 'いて');
    await record(p, 0, 700);
    await next().click();
    await p.waitForFunction(() => /まだ送信できていません/.test(document.querySelector('.q__wait').textContent), null, { timeout: 15000 });
    assert.strictEqual(await p.inputValue('#f-seg-0'), 'びんたが');
    assert.strictEqual(rowsOf(people[5].id).length, 1);
    await p.unroute(apiPattern);
    await p.waitForSelector('#f-example', { timeout: 20000 });
    await until(() => rowsOf(people[5].id).length === 2, '2問目の保存');
    assert.strictEqual(await waitText(), '');
    await p.context().close();
    test.page = page;
  });

  console.log('録音の音');
  await test('音が入っていない録音は受けつけない。小さすぎる録音は、録り直しをすすめる', async () => {
    const silent = makeWav(path.join(tmp, 'silent.wav'), 3, 0);
    const quiet = makeWav(path.join(tmp, 'quiet.wav'), 3, 0.006);
    for (const [file, kind] of [[silent, 'silent'], [quiet, 'quiet']]) {
      const b = await chromium.launch({ args: FAKE_MIC.concat('--use-file-for-fake-audio-capture=' + file) });
      const p = await newPage({}, b);
      await p.goto(`${site}/?demo=1#/login`);
      await p.fill('#login-id', 'K900'); await p.fill('#login-pw', '0000');
      await p.click('button[type=submit]');
      await p.waitForSelector('.board .tile');
      await p.click('.tile--here');
      await p.waitForSelector('.page--practice');
      const rec = p.locator('.rec').first();
      await rec.locator('.rec__btn').click();
      await p.waitForFunction(() => document.querySelector('.rec').getAttribute('data-state') === 'recording', null, { timeout: 10000 });
      await p.waitForTimeout(900);
      await rec.locator('.rec__btn').click();
      if (kind === 'silent') {
        await p.waitForFunction(() => /音が入っていませんでした/.test(document.querySelector('.rec__note').textContent), null, { timeout: 10000 });
        assert.strictEqual(await recState(p, 0), 'idle');
        assert.strictEqual(await p.locator('.practice__check').count(), 0);
      } else {
        await p.waitForFunction(() => document.querySelector('.rec').getAttribute('data-state') === 'done', null, { timeout: 10000 });
        assert.ok(/声がとても小さく録音されています/.test(await p.locator('.practice__after').innerText()));
        if (shots) await p.screenshot({ path: path.join(shots, 'live-12-quiet.png'), fullPage: true });
      }
      await b.close();
    }
  });
  await test('マイクを許可しないと案内が出る。録音できないままでも先へ進めて、問題の画面でまた録音をためせる', async () => {
    // 画面のないブラウザでは「許可しない」を選んだ状態を作れないので、マイクの呼び出しを「拒否された」形に置きかえる
    const q = await newPage({ context: { permissions: [] }, init: () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    } });
    test.page = q;
    await login(q, people[6]);
    await q.waitForSelector('.board .tile');
    await q.click('.tile--here');
    await q.waitForSelector('.page--practice');
    await q.locator('.rec__btn').click();
    await q.waitForFunction(() => /許可されませんでした/.test(document.querySelector('.rec__note').textContent), null, { timeout: 10000 });
    assert.strictEqual(await q.locator('.linkbtn--strong').count(), 1);
    if (shots) await q.screenshot({ path: path.join(shots, 'live-13-mic-denied.png'), fullPage: true });
    await q.getByRole('button', { name: '録音できないとき' }).click();
    await q.getByRole('button', { name: '録音できないまま進む' }).click();
    await q.waitForFunction(() => /録音できないまま進みますか/.test((document.querySelector('.dialog__title') || {}).textContent || ''));
    await q.getByRole('button', { name: 'このまま進む' }).click();
    await q.waitForSelector('.board .tile--here');
    assert.ok(/1歩目/.test(await q.locator('.tile--here').getAttribute('aria-label')));
    await openStep(q);
    await q.waitForSelector('#f-answer');
    assert.strictEqual(await q.locator('.rec__btn').count(), 1, '問題の画面では、もう一度録音をためせるはず');
    await q.locator('.rec__btn').click();
    await q.waitForFunction(() => /許可されませんでした/.test(document.querySelector('.rec__note').textContent), null, { timeout: 10000 });
    await q.getByRole('button', { name: 'マイクが使えないとき' }).click();
    await q.getByRole('button', { name: '録音なしで進む' }).click();
    await q.waitForSelector('.rec--off');
    await q.fill('#f-answer', 'びんた');
    await q.click('text=つぎへ');
    await q.waitForSelector('.segs');
    await until(() => rowsOf(people[6].id).length === 1, '保存');
    assert.strictEqual(rowsOf(people[6].id)[0][16], 'マイクが使えない');
    await q.context().close();
    test.page = page;
  });

  console.log('まわりの音（雑音）');
  const answerCol = name => world.sheetRows('回答')[0].indexOf(name);
  const setSetting = (key, value) => { const row = world.ss.getSheetByName('設定').rows.find(r => r[0] === key); assert.ok(row, '設定の項目がない: ' + key); row[1] = value; };
  await test('うるさい場所：れんしゅうで知らせ、問題でも注意が出る。そのまま進めて、数値が表に残る。目安を 0 にすると注意は出ない', async () => {
    const noisy = makeSpeechWav(path.join(tmp, 'noisy.wav'), 0.067);          // 声と雑音の差が 10dB くらい
    const b = await chromium.launch({ args: FAKE_MIC.concat('--use-file-for-fake-audio-capture=' + noisy) });
    const p = await newPage({}, b);
    test.page = p;
    const who = people[7];
    await login(p, who);
    await p.waitForSelector('.board .tile');
    await p.click('.tile--here');
    await p.waitForSelector('.page--practice');
    assert.ok(/静かな場所で録音してください/.test(await p.locator('.page--practice').innerText()), 'れんしゅうの画面に「静かな場所で」の案内がない');
    await record(p, 0, 1300);
    await p.waitForSelector('.practice__check--noisy');
    assert.ok(/まわりの音が大きいようです/.test(await p.locator('.practice__after').innerText()));
    assert.ok(/まわりの音が大きいようです/.test(await p.locator('.rec__note').innerText()));
    assert.strictEqual(await p.locator('.card--ok').count(), 0, '「録音できています」も出ている');
    await shot(p, 'live-14-practice-noisy');
    await p.locator('.practice__check--noisy .btn--primary').click();          // 録り直す
    assert.strictEqual(await recState(p, 0), 'idle');
    assert.strictEqual(await p.locator('.practice__check').count(), 0);
    await record(p, 0, 1300);
    await p.locator('.practice__check--noisy .btn--plain').click();            // このまま進む
    await p.waitForSelector('.board .tile--here');
    await openStep(p);
    await p.waitForSelector('#f-answer');
    await p.fill('#f-answer', 'びんた');
    await record(p, 0, 1300);
    assert.ok(/まわりの音が大きいようです/.test(await p.locator('.rec__note').innerText()));
    await shot(p, 'live-15-word-noisy');
    await p.click('text=つぎへ');
    await p.waitForSelector('.segs');                                           // 注意が出ていても、そのまま進める
    await until(() => rowsOf(who.id).length === 1, '保存');
    const r1 = rowsOf(who.id)[0];
    const snr = r1[answerCol('声と雑音の差（dB）')];
    assert.ok(typeof snr === 'number' && snr > 3 && snr < 18, '声と雑音の差 ' + snr);
    const info = JSON.parse(r1[answerCol('技術情報')]);
    assert.strictEqual(info.main.snr, snr);
    assert.ok(info.main.noise < -15 && info.main.noise > -35, 'まわりの音 ' + info.main.noise);

    setSetting('雑音の注意の目安（dB）', 0);                                     // 調査者が「注意を出さない」にした
    await p.goto(`${site}/#/map`); await p.reload();
    await p.waitForFunction(() => window.KS && KS.state.survey && KS.state.survey.settings.noiseWarnDb === 0, null, { timeout: 15000 });
    await p.waitForSelector('.board .tile--here');
    await openStep(p);
    await p.waitForSelector('.segs');
    await p.fill('#f-seg-0', 'びんたが'); await p.fill('#f-seg-1', 'いて');
    await record(p, 0, 1300);
    assert.strictEqual((await p.locator('.rec__note').innerText()).trim(), '', '目安が 0 なのに注意が出ている');
    await p.click('text=つぎへ');
    await until(() => rowsOf(who.id).length === 2, '保存');
    const snr2 = rowsOf(who.id)[1][answerCol('声と雑音の差（dB）')];
    assert.ok(typeof snr2 === 'number' && snr2 < 18, '注意を出さなくても、数値は残るはず ' + snr2);
    setSetting('雑音の注意の目安（dB）', 20);
    await b.close();
    test.page = page;
  });
  await test('静かな場所：れんしゅうでも問題でも注意は出ず、数値は大きく残る', async () => {
    const calm = makeSpeechWav(path.join(tmp, 'calm.wav'), 0.0007);            // 声と雑音の差が 50dB くらい
    const b = await chromium.launch({ args: FAKE_MIC.concat('--use-file-for-fake-audio-capture=' + calm) });
    const p = await newPage({}, b);
    test.page = p;
    world.call('addParticipants', 1);
    const last = world.sheetRows('参加者').slice(-1)[0], who = { id: last[0], pw: last[1] };
    await login(p, who);
    await p.waitForSelector('.board .tile');
    await p.click('.tile--here');
    await p.waitForSelector('.page--practice');
    await record(p, 0, 1300);
    assert.ok(/声は録音できています/.test(await p.locator('.practice__after').innerText()));
    assert.strictEqual(await p.locator('.practice__check--noisy').count(), 0);
    assert.strictEqual((await p.locator('.rec__note').innerText()).trim(), '');
    await p.getByRole('button', { name: '地図へすすむ' }).click();
    await p.waitForSelector('.board .tile--here');
    await openStep(p);
    await p.waitForSelector('#f-answer');
    await p.fill('#f-answer', 'びんた');
    await record(p, 0, 1300);
    assert.strictEqual((await p.locator('.rec__note').innerText()).trim(), '');
    await p.click('text=つぎへ');
    await p.waitForSelector('.segs');
    await until(() => rowsOf(who.id).length === 1, '保存');
    const snr = rowsOf(who.id)[0][answerCol('声と雑音の差（dB）')];
    assert.ok(typeof snr === 'number' && snr > 35, '声と雑音の差 ' + snr);
    await b.close();
    test.page = page;
  });

  console.log('そのほか');
  await test('保存先への送信は、決まった形（text/plain のPOST）だけ', async () => {
    assert.ok(world.control.calls.length > 10);
    assert.ok(world.control.calls.every(c => ['login', 'bootstrap', 'save'].indexOf(c) >= 0), world.control.calls.join(','));
  });
  await test('数式として入った回答がない・画面のエラーがない', async () => {
    assert.strictEqual(world.ss.sheets.reduce((n, s) => n + s.formulas.length, 0), 0);
    assert.deepStrictEqual(errors, []);
  });

  await browser.close(); apiServer.close(); siteServer.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 何もしない */ }
  console.log(`\n${passed} 件合格` + (failed ? `、${failed} 件失敗` : ''));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
