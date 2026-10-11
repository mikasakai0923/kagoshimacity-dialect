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

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) {
    failed++;
    console.error('  NG  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      '));
    if (shots && test.page) { try { fs.mkdirSync(shots, { recursive: true }); await test.page.screenshot({ path: path.join(shots, 'NG-' + failed + '.png'), fullPage: true }); } catch (e2) { /* 何もしない */ } }
  }
}

(async () => {
  const world = createGasWorld(code);
  world.call('setup');
  world.call('addParticipants', 3);
  const people = world.sheetRows('参加者').slice(1).map(r => ({ id: r[0], pw: r[1] }));
  const apiServer = await startServer(world, API);
  const siteServer = await startStatic(root, SITE);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  const errors = [];
  async function newPage(opt) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'], locale: 'ja-JP' }, opt || {}));
    const page = await ctx.newPage();
    await page.route('**/config.js*', async route => {
      const res = await route.fetch();
      const body = (await res.text()).replace('apiUrl: ""', `apiUrl: "http://localhost:${API}/exec"`);
      await route.fulfill({ response: res, body });
    });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
    return page;
  }
  const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true }); } };
  const rows = () => world.sheetRows('回答').slice(1);
  const untilRows = async (n, ms) => { const t0 = Date.now(); while (rows().length < n) { if (Date.now() - t0 > (ms || 15000)) throw new Error(`回答が ${n} 行になりません（いま ${rows().length} 行）`); await new Promise(r => setTimeout(r, 100)); } };
  async function record(page, nth, ms) {
    const rec = page.locator('.rec').nth(nth || 0);
    await rec.locator('.rec__btn').click();
    await page.waitForFunction(i => document.querySelectorAll('.rec')[i].getAttribute('data-state') === 'recording', nth || 0, { timeout: 10000 });
    await page.waitForTimeout(ms || 900);
    await rec.locator('.rec__btn').click();
    await page.waitForFunction(i => document.querySelectorAll('.rec')[i].getAttribute('data-state') === 'done', nth || 0, { timeout: 10000 });
  }
  async function login(page, who, pw) {
    await page.goto(`http://localhost:${SITE}/#/login`);
    await page.waitForSelector('#login-id');
    await page.fill('#login-id', who.id);
    await page.fill('#login-pw', pw === undefined ? who.pw : pw);
    await page.click('button[type=submit]');
  }
  const pill = page => page.locator('.pill').first().innerText();

  const page = await newPage();
  test.page = page;
  console.log('ログイン');
  await test('紹介ページが出て、本番の設定ではお試しの表示が出ない', async () => {
    await page.goto(`http://localhost:${SITE}/`);
    await page.waitForSelector('.hero__title');
    assert.strictEqual(await page.locator('.demo-banner').count(), 0);
    await shot(page, 'live-01-intro');
  });
  await test('まちがったパスワードでは入れず、理由が出る', async () => {
    await login(page, people[0], '999999x');
    await page.waitForFunction(() => document.querySelector('.form-error').textContent.length > 0);
    assert.ok(/ちがいます/.test(await page.locator('.form-error').innerText()));
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

  console.log('れんしゅう → 1歩目');
  await test('れんしゅうの前は、歩に進めない', async () => {
    await page.goto(`http://localhost:${SITE}/#/step/1`);
    await page.waitForSelector('.page--practice');
  });
  await test('録音のれんしゅうをして「聞こえた」で地図にもどる', async () => {
    await record(page, 0, 700);
    await page.click('text=聞く');
    await page.waitForTimeout(300);
    await page.click('text=聞こえた');
    await page.waitForSelector('.board .tile--here');
    assert.ok(/1歩目/.test(await page.locator('.tile--here').getAttribute('aria-label')));
    assert.strictEqual(rows().length, 0, 'れんしゅうの録音は送られないはず');
  });
  await test('語彙：書かずに進めない／録音なしで進めない／書いて録音すると進める', async () => {
    await page.click('.tile--here');
    await page.click('.dialog .btn--primary');
    await page.waitForSelector('#f-answer');
    await page.click('text=つぎへ');
    assert.ok(/回答をひらがなで/.test(await page.locator('.form-error').innerText()));
    await page.fill('#f-answer', 'びんた');
    await page.click('text=つぎへ');
    assert.ok(/録音がまだ/.test(await page.locator('.form-error').innerText()));
    await record(page, 0, 1000);
    await page.fill('#f-note', '=1+1 あたまともいう');
    await shot(page, 'live-02-word');
    await page.click('text=つぎへ');
    await page.waitForSelector('.segs');
    await untilRows(1);
    const r = rows()[0];
    assert.strictEqual(r[1], people[0].id); assert.strictEqual(r[3], 'S001'); assert.strictEqual(r[4], '語彙'); assert.strictEqual(r[5], '頭');
    assert.strictEqual(r[6], '回答済'); assert.strictEqual(r[7], 'びんた'); assert.strictEqual(r[11], '=1+1 あたまともいう');
    assert.ok(/_S001_kaitou_/.test(r[12])); assert.ok(r[17] >= 0.8 && r[17] <= 2.5, '録音の長さ ' + r[17]);
    assert.ok(r[18] === 48000 || r[18] === 44100, 'サンプリング周波数 ' + r[18]);
    assert.ok(r[19] > 0); assert.ok(/Chrome/.test(r[20]));
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
  await test('例文：文節の一部が空欄なら確かめてから進む。文節ごとの回答が保存される', async () => {
    await page.fill('#f-seg-0', 'びんたが');
    await record(page, 0, 800);
    await page.click('text=つぎへ');
    await page.waitForSelector('.dialog');
    assert.ok(/書いていない文節/.test(await page.locator('.dialog__title').innerText()));
    await page.click('text=もどって書く');
    await page.fill('#f-seg-1', 'いて');
    await page.fill('#f-note', 'びんたがうずく');
    await shot(page, 'live-03-sentence');
    await page.click('text=つぎへ');
    await page.waitForSelector('#f-example');
    await untilRows(2);
    const r = rows()[1];
    assert.strictEqual(r[3], 'S002'); assert.strictEqual(r[7], 'びんたが いて'); assert.strictEqual(r[8], '頭が｜痛い'); assert.strictEqual(r[9], 'びんたが｜いて');
    assert.strictEqual(r[11], 'びんたがうずく');
  });
  await test('語彙＋提案例文：録音が2本保存され、歩クリアの画面になる', async () => {
    await page.fill('#f-answer', 'め');
    await record(page, 0, 700);
    await page.fill('#f-example', 'めが ふとか');
    await page.click('text=この歩をおえる');
    assert.ok(/例文の録音がまだ/.test(await page.locator('.form-error').innerText()));
    await record(page, 1, 900);
    await page.click('text=この歩をおえる');
    await page.waitForSelector('.clear__title');
    await untilRows(3);
    const r = rows()[2];
    assert.ok(/_kaitou_/.test(r[12]) && /_reibun_/.test(r[14])); assert.strictEqual(r[10], 'めが ふとか');
    assert.strictEqual(world.files().length, 4);
    await page.waitForFunction(() => /送信ずみ/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    await shot(page, 'live-04-clear');
  });

  console.log('つづき・やり直し');
  await test('読みこみ直しても、ログインと進み具合が残っている', async () => {
    await page.goto(`http://localhost:${SITE}/`);
    await page.waitForSelector('text=つづきから歩く');
    await page.click('text=つづきから歩く');
    await page.waitForSelector('.board .tile--here');
    assert.ok(/2歩目/.test(await page.locator('.tile--here').getAttribute('aria-label')));
    assert.strictEqual(await page.locator('.tile--done').count(), 2);
    await shot(page, 'live-05-map');
  });
  await test('通信が切れているあいだの回答は端末に残り、つながると送られる', async () => {
    await page.click('.tile--here');
    await page.click('.dialog .btn--primary');
    await page.waitForSelector('#f-seg-0');
    await page.route(`http://localhost:${API}/**`, r => r.abort());
    await page.fill('#f-seg-0', 'あめが'); await page.fill('#f-seg-1', 'ふっちょっ');
    await record(page, 0, 700);
    await page.click('text=つぎへ');
    await page.waitForSelector('#f-seg-2');
    await page.waitForTimeout(800);
    assert.strictEqual(rows().length, 3);
    await page.goto(`http://localhost:${SITE}/#/map`);
    await page.reload();
    await page.waitForSelector('.board .tile');
    await page.waitForFunction(() => /未送信 1件/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    assert.ok(/のこり 1問/.test(await page.locator('.tile--here').getAttribute('aria-label')), '未送信の回答も「答えた」あつかいのはず');
    await shot(page, 'live-06-unsent');
    await page.unroute(`http://localhost:${API}/**`);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await untilRows(4, 20000);
    await page.waitForFunction(() => /送信ずみ/.test(document.querySelector('.pill').textContent), null, { timeout: 15000 });
    assert.strictEqual(rows()[3][3], 'S004'); assert.strictEqual(rows()[3][9], 'あめが｜ふっちょっ');
    assert.strictEqual(world.files().length, 5);
  });
  await test('「使わない」は録音なしで記録される', async () => {
    await page.click('.tile--here');
    await page.click('.dialog .btn--primary');
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
    await shot(page, 'live-07-goal');
  });
  await test('歩きおえた歩を「もう一度こたえる」と、行が増える（前の回答も残る）', async () => {
    await page.click('text=地図にもどる');
    await page.waitForSelector('.board .tile');
    await page.locator('.tile--done').nth(2).click();
    await page.getByRole('button', { name: 'もう一度こたえる' }).click();
    await page.waitForSelector('#f-seg-0');
    await page.click('text=マイクが使えないとき');
    await page.getByRole('button', { name: '録音なしで進む' }).click();
    await page.fill('#f-seg-0', 'あめん'); await page.fill('#f-seg-1', 'ふっちょっど');
    await page.click('text=つぎへ');
    await untilRows(6);
    const r = rows()[5];
    assert.strictEqual(r[3], 'S004'); assert.strictEqual(r[16], 'マイクが使えない'); assert.strictEqual(r[12], '');
    await page.click('.iconbtn[aria-label="地図にもどる"]');
    await page.waitForSelector('.board .tile');
  });

  console.log('ログインの期限・別の参加者');
  await test('ログインの期限が切れても回答は残り、ログインし直すと送られる', async () => {
    await page.locator('.tile--done').nth(2).click();
    await page.getByRole('button', { name: 'もう一度こたえる' }).click();
    await page.waitForSelector('#f-seg-0');
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ks1:session')); s.token = s.token.slice(0, -4) + 'AAAA'; localStorage.setItem('ks1:session', JSON.stringify(s)); KS.state.session.token = s.token; });
    await page.fill('#f-seg-0', 'あめが'); await page.fill('#f-seg-1', 'ふいよっ');
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

  console.log('そのほか');
  await test('マイクを許可しないと、案内が出て「マイクが使えないとき」が目立つ', async () => {
    const p2 = await newPage({ permissions: [] });
    const b2 = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'] });
    const c2 = await b2.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
    const q = await c2.newPage();
    await q.route('**/config.js*', async route => { const res = await route.fetch(); await route.fulfill({ response: res, body: (await res.text()).replace('apiUrl: ""', `apiUrl: "http://localhost:${API}/exec"`) }); });
    await q.goto(`http://localhost:${SITE}/#/login`);
    await q.fill('#login-id', people[2].id); await q.fill('#login-pw', people[2].pw);
    await q.click('button[type=submit]');
    await q.waitForSelector('.board .tile');
    await q.click('.tile--here');
    await q.waitForSelector('.page--practice');
    await q.locator('.rec__btn').click();
    await q.waitForFunction(() => /許可されていません|はじめられませんでした|使えませんでした/.test(document.querySelector('.rec__note').textContent), null, { timeout: 10000 });
    if (shots) await q.screenshot({ path: path.join(shots, 'live-08-mic-denied.png'), fullPage: true });
    await q.getByRole('button', { name: '録音できないとき' }).click();
    await q.getByRole('button', { name: '録音なしで進む' }).click();
    await q.waitForFunction(() => /録音なしで進みますか/.test((document.querySelector('.dialog__title') || {}).textContent || ''));
    await q.getByRole('button', { name: '録音なしで進む' }).click();
    await q.waitForSelector('.board .tile');
    assert.ok(/録音なしで回答しています/.test(await q.locator('.notice').first().innerText()));
    await b2.close(); await p2.context().close();
  });
  await test('保存先への送信は、決まった形（text/plain のPOST）だけ', async () => {
    assert.ok(world.control.calls.length > 10);
    assert.ok(world.control.calls.every(c => ['login', 'bootstrap', 'save'].indexOf(c) >= 0), world.control.calls.join(','));
  });
  await test('数式として入った回答がない・画面のエラーがない', async () => {
    assert.strictEqual(world.ss.sheets.reduce((n, s) => n + s.formulas.length, 0), 0);
    assert.deepStrictEqual(errors, []);
  });

  await browser.close(); apiServer.close(); siteServer.close();
  console.log(`\n${passed} 件合格` + (failed ? `、${failed} 件失敗` : ''));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
