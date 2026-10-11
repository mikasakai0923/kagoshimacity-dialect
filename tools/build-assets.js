#!/usr/bin/env node
/*
 * 開発用：フォントと絵文字イラストをサイト内に取り込むスクリプト。
 *
 * 使い方（サイトを使うだけなら実行は不要です）:
 *   mkdir vendor && cd vendor && npm init -y
 *   npm install @fontsource/zen-maru-gothic@5.3.1 @fontsource/mochiy-pop-one@5.3.0 @twemoji/svg@15.0.0
 *   node ../tools/build-assets.js ./node_modules ..
 */
const fs = require('fs');
const path = require('path');

const nm = path.resolve(process.argv[2] || './node_modules');
const root = path.resolve(process.argv[3] || '.');

// ---------- フォント ----------
const fontJobs = [
  { pkg: '@fontsource/zen-maru-gothic', dir: 'zen-maru-gothic', css: ['500.css', '700.css'] },
  { pkg: '@fontsource/mochiy-pop-one', dir: 'mochiy-pop-one', css: ['400.css'] }
];
let fontsCss = '/* 自動生成（tools/build-assets.js）。フォントはサイト内に置き、外部サービスへは接続しません。 */\n';
let fontFiles = 0;
for (const job of fontJobs) {
  const outDir = path.join(root, 'fonts', job.dir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const cssName of job.css) {
    let css = fs.readFileSync(path.join(nm, job.pkg, cssName), 'utf8');
    css = css.replace(/src:\s*url\(\.\/files\/([^)]+\.woff2)\) format\('woff2'\),\s*url\([^)]+\) format\('woff'\);/g, (m, file) => {
      fs.copyFileSync(path.join(nm, job.pkg, 'files', file), path.join(outDir, file));
      fontFiles++;
      return `src: url(../fonts/${job.dir}/${file}) format('woff2');`;
    });
    css = css.replace(/\/\*[^*]*\*\/\n/g, '');
    fontsCss += css + '\n';
  }
  fs.copyFileSync(path.join(nm, job.pkg, 'LICENSE'), path.join(outDir, 'OFL.txt'));
}
fs.writeFileSync(path.join(root, 'css', 'fonts.css'), fontsCss);

// ---------- 絵文字イラスト（Twemoji） ----------
const icons = {
  tree: '1f333', fire: '1f525', eye: '1f441', tooth: '1f9b7', leaf: '1f343', flower: '1f338',
  sake: '1f376', bell: '1f514', ear: '1f442', dog: '1f415', rock: '1faa8', knife: '1f52a',
  fish: '1f41f', house: '1f3e0', garden: '1f3e1', town: '1f3d8', rice: '1f33e', book: '1f4d5',
  boy: '1f466', girl: '1f467', child: '1f9d2', me: '1f64b', person: '1f9d1', run: '1f3c3',
  walk: '1f6b6', eyes: '1f440', search: '1f50d', handshake: '1f91d', question: '2753',
  exclamation: '2757', elephant: '1f418', mouse: '1f401', ferry: '26f4', anchor: '2693',
  car: '1f697', thought: '1f4ad', dash: '1f4a8', station: '1f689', shopping: '1f6cd',
  shrine: '26e9', mountain: '26f0', volcano: '1f30b', head: '1f9d1', rain: '1f327',
  umbrella: '2614', hand: '270b', foot: '1f9b6', nose: '1f443', mouth: '1f444', cat: '1f408',
  sun: '2600', moon: '1f319', star: '2b50', water: '1f4a7', rice_bowl: '1f35a', tea: '1f375',
  sweet_potato: '1f360', tangerine: '1f34a', pig: '1f437', tram: '1f68b'
};
const iconDir = path.join(root, 'images', 'icons');
fs.mkdirSync(iconDir, { recursive: true });
let n = 0;
for (const [name, cp] of Object.entries(icons)) {
  const src = path.join(nm, '@twemoji', 'svg', cp + '.svg');
  if (!fs.existsSync(src)) { console.warn('見つかりません:', name, cp); continue; }
  fs.copyFileSync(src, path.join(iconDir, name + '.svg'));
  n++;
}
console.log(`fonts: ${fontFiles} files, icons: ${n} files`);
