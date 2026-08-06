# skinslides-web

インタラクティブ映像作品「skinslides」の実装リポジトリ。

映像・音響の解析データを共通の質感ベクトル空間（10軸）に投影し、再生中の音声から
検出したオノマトペをもとに、次に表示する映像を動的に選び続けます。同じ音源からでも、
再生のたびに異なる映像の組み合わせが生成されます。

- Sound: Otomo Yoshihide
- Dance: Alessio Silvestrin
- System Re-engineering & AI Logic: Richi Owaki, AI Agent

---

## 📖 ドキュメント

- **[システムアーキテクチャ](docs/SYSTEM_ARCHITECTURE.md)** ← まずこれを読む
  - 10軸ベクトル空間、オノマトペ駆動の映像選択、ライブマップの仕組みを解説
- **[開発者向けドキュメント](docs/DEVELOPMENT/)**
  - 設計方針の検証、作業指示、変更履歴。実装・改造する場合はこちら

## 🚀 ローカルでの実行

```bash
python server.py
```

`http://localhost:8000` を開くとプレビューできます（ローカル映像素材は含まれていないため、
映像はCloudflare R2から取得されます／`videos/` に360p素材を配置するとオフラインでも
確認できます）。

`?fast=1` は special / test-level2 のみ有効なデバッグオプションです（Play B /
Combination では無効）。

## ⚖️ ライセンス

音楽・映像・パフォーマンス素材は **All Rights Reserved** です。プログラムコード（システム
構成・AIロジック）は **CC BY 4.0** で公開しています。詳細は [NOTICE.md](NOTICE.md) と
[LICENSE](LICENSE) を参照してください。
