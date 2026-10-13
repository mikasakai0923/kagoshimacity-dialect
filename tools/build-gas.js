#!/usr/bin/env node
/*
 * 開発用：管理画面の中身（gas/admin.html）を、Google 側のプログラム（gas/Code.gs）の中に入れる。
 *
 *   node tools/build-gas.js           # 入れる（gas/admin.html を直したら、かならず行う）
 *   node tools/build-gas.js --check   # 入っているものが、いまの gas/admin.html と同じかを確かめるだけ
 *
 * Apps Script に貼り付けるファイルを1つだけにしておくために、HTML を文字として Code.gs の中に持たせています。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const BEGIN = '// KS:ADMIN-HTML:BEGIN';
const END = '// KS:ADMIN-HTML:END';
const CHUNK = 900;        // 1行が長くなりすぎないように、この文字数ごとに切る

function adminBlock(html) {
  const chars = Array.from(String(html).replace(/\r\n?/g, '\n'));      // 絵文字などが途中で切れないように、文字の単位で切る
  const chunks = [];
  for (let i = 0; i < chars.length; i += CHUNK) chunks.push(chars.slice(i, i + CHUNK).join(''));
  const lit = s => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return BEGIN + '\nvar KS_ADMIN_HTML = [\n' + chunks.map(lit).join(',\n') + "\n].join('');\n" + END;
}

function embed(code, html) {
  const a = code.indexOf(BEGIN), b = code.indexOf(END);
  if (a < 0 || b < a) throw new Error('Code.gs に、管理画面を入れる場所（' + BEGIN + ' 〜 ' + END + '）がありません');
  return code.slice(0, a) + adminBlock(html) + code.slice(b + END.length);
}

module.exports = { adminBlock, embed, BEGIN, END };

if (require.main === module) {
  const codePath = path.join(root, 'gas', 'Code.gs');
  const html = fs.readFileSync(path.join(root, 'gas', 'admin.html'), 'utf8');
  const code = fs.readFileSync(codePath, 'utf8');
  if (html.split('"__KS_BOOT__"').length !== 2) {
    console.error('gas/admin.html に、はじめの情報を入れる場所 "__KS_BOOT__" が、ちょうど1つ必要です');
    process.exit(1);
  }
  const next = embed(code, html);
  if (process.argv.includes('--check')) {
    if (next !== code) { console.error('gas/Code.gs の中の管理画面が古くなっています。node tools/build-gas.js を実行してください。'); process.exit(1); }
    console.log('gas/Code.gs の中の管理画面は、gas/admin.html と同じです。');
  } else {
    if (next !== code) fs.writeFileSync(codePath, next);
    console.log((next !== code ? '入れました' : '変わりなし') + '：管理画面 ' + Math.round(Buffer.byteLength(html) / 1024) + ' KB → gas/Code.gs ' + Math.round(Buffer.byteLength(next) / 1024) + ' KB');
  }
}
