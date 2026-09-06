import type { MetadataRoute } from "next";

/**
 * ホーム画面に置いて、ブラウザの枠なしで開けるようにする（PWA）。
 *
 * 開いた直後に出るのは `/play`。**インストールする理由がプレイ中に開くことだから**で、
 * 他の画面へはナビからいつでも行ける。アイコンの元データは `public/icon-source.svg`
 * （書き出しは `qlmanage -t -s <px> -o . icon-source.svg`）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "rekord_graph",
    short_name: "rekord_graph",
    description: "DJ トランジション・ナレッジベース",
    start_url: "/play",
    scope: "/",
    display: "standalone",
    background_color: "#08090c",
    theme_color: "#08090c",
    lang: "ja",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // maskable = Android が好きな形に切り抜く。地色が全面にあるので切られても崩れない
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // アイコン長押しから直接開く
    shortcuts: [
      { name: "プレイ", url: "/play" },
      { name: "グラフ", url: "/graph" },
      { name: "曲を探す", url: "/" },
    ],
  };
}
