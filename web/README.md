# rekord_graph / web

Next.js のアプリ本体。セットアップと使い方は [リポジトリ直下の README](../README.md) を参照。

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

- Notion の設定は `~/.config/rekord_graph/config.json`（ローカル）か環境変数（Vercel）。
  必要な変数は [`.env.example`](.env.example)
- 見た目の約束は [`DESIGN.md`](DESIGN.md)、実装の約束は [`CLAUDE.md`](../CLAUDE.md) の「web/ の約束」
