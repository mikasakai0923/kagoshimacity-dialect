# かごしま ことばさんぽ

市民に参加してもらって、鹿児島のことばを文字と声で集めるための調査サイトです（試行版）。

参加者は、参加者ナンバーとパスワードでログインし、すごろくの道を1歩（10問くらい）ずつ進みながら、
設問ごとに「ひらがなの回答」と「声の録音」を残します。

## しくみ

```
参加者のスマートフォン ──→ このサイト（GitHub Pages。画面だけ。回答は置かれません）
        │
        └─ 回答と録音 ──→ Google Apps Script ──→ Google スプレッドシート（回答）
                                              └→ Google ドライブ（録音・WAV）
```

- 調査項目、参加者の登録、回答、録音は、すべて調査者の Google アカウントの中にあります。このリポジトリには入りません。
- 調査者は、Google 側の「管理画面」で、進み具合や届いた回答・録音を確かめたり、参加者を追加したりできます（調査者本人だけが開けます）。
- 回答は、まず参加者の端末に保存され、通信できるときに自動で送られます。
- サイトは外部のサービス（フォント配信、アクセス解析など）に接続しません（調査者が「イラスト」欄に外部の画像アドレスを書いた場合だけ、その画像の置き場所に接続します）。

## はじめかた

1. このリポジトリを GitHub Pages で公開します（Settings → Pages → Branch を `main` / `/ (root)` にして Save）。
2. `config.js` の `apiUrl` が空のあいだは「お試しモード」で動きます。見本の5問で、画面と流れを確かめられます（回答はどこにも送られません）。
3. Google 側の設定をします → [docs/setup-google.md](docs/setup-google.md)
4. `config.js` の `apiUrl` に、Google 側でできた URL を入れると、本番として動きます。

日々の運用（管理画面の使い方、参加者の登録、項目の書きかえ、回答の見方）→ [docs/operation.md](docs/operation.md)

## サイトの文章を変える

紹介ページの文章、サイトの名前、問い合わせ先は `config.js` に書いてあります。`" "` の中だけを書きかえてください。

設問の上に出る教示文や質問文は、Google スプレッドシートの「設定」シートで変えられます。

## フォルダの中身

| 場所 | 内容 |
| --- | --- |
| `index.html`、`config.js` | サイトの入口と設定 |
| `css/`、`js/`、`fonts/`、`images/` | 画面のプログラム、文字、絵 |
| `gas/Code.gs` | Google 側の保存プログラム（スプレッドシートの Apps Script に貼り付けて使う。調査項目は見本だけ）。管理画面も、この中に入っています |
| `gas/admin.html` | 管理画面のもと（1つのファイルに、見た目とプログラムをまとめたもの）。直したら `node tools/build-gas.js` で `gas/Code.gs` に入れ直します |
| `docs/` | 設定手順と運用の手引き |
| `tools/` | 開発用の道具（下を参照） |

## 開発用の道具

サイトを使うだけなら不要です。Node.js が必要です。

```
node tools/serve.js          # 手元でサイトを開く（http://localhost:8765/?demo=1 でお試しモード）
node tools/mock-gas.js       # Google 側の「まね」サーバー（http://localhost:8766/exec）
node tools/test-backend.js   # Google 側プログラムのテスト
node tools/test-recorder.js  # 録音の「声と雑音の差」の見積もりのテスト
node tools/e2e.js            # ブラウザを動かして最初から最後まで確かめるテスト（Playwright が必要）

node tools/build-gas.js      # gas/admin.html（管理画面）を gas/Code.gs の中に入れ直す（--check で、入れ忘れがないかだけ確かめる）
node tools/test-admin.js     # 管理画面のための、Google 側プログラムのテスト
node tools/e2e-admin.js      # ブラウザを動かして管理画面を確かめるテスト（Playwright が必要）
node tools/test-upgrade.js <前のプログラム>   # 前の版から今の版へ入れかえても、回答や設定がそのまま残ることを確かめる
```

`tools/mock-gas.js` は、`gas/Code.gs` をそのまま読みこんで、スプレッドシートとドライブをメモリ上でまねたものです。
Google の実物と完全に同じではなく、テストに使うブラウザもパソコン用の Chromium だけです。
公開前には、Google の実物と、実物のスマートフォン（iPhone・Android）での確認が必要です（[docs/setup-google.md](docs/setup-google.md) の手順7）。
管理画面も同じで、「持ち主だけが開ける」ことや、印刷・録音の再生が Google の実物の中で動くことは、実物で確かめる必要があります。

JavaScript や CSS を直したときは、`index.html` の `?v=7` の数字を増やしてください（古いファイルが読まれ続けるのを防ぎます）。

## 使わせていただいているもの

- 絵文字のイラスト：[Twemoji](https://github.com/jdecked/twemoji)（CC BY 4.0）。くわしくは `images/icons/CREDITS.txt`
- 文字：[Zen Maru Gothic](https://github.com/googlefonts/zen-marugothic)、[Mochiy Pop One](https://github.com/fontdasu/Mochiypop)（SIL Open Font License 1.1）。ライセンス文は `fonts/` の各フォルダ
- 案内役（桜島大根）、桜島、地図の絵は、このサイト用に描いたものです
