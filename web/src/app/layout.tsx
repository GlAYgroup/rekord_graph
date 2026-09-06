import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

/**
 * Latin と数字は機材のシルク印刷に寄せた2書体、日本語はシステム（ヒラギノ）。
 * next/font は同一オリジンから配信されるので、ブースの回線が細くても落ちない。
 */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["wdth"],
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-display",
});

export const metadata: Metadata = {
  title: "rekord_graph",
  description: "DJ トランジション・ナレッジベース",
  // ホーム画面に置いたときにブラウザの枠なしで開く（マニフェストは app/manifest.ts）
  appleWebApp: {
    capable: true,
    title: "rekord_graph",
    // black-translucent は中身が時計の下に潜る。上端に貼り付く見出しがあるので使わない
    statusBarStyle: "black",
  },
  // Next が出すのは新しい `mobile-web-app-capable` だけ。iOS 15.4 より前は
  // マニフェストの display を見ないので、古い名前も自分で足しておく
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#08090c",
  // maximumScale は付けない: ページ拡大を奪うのは WCAG 1.4.4 違反で、
  // iOS はそもそも無視する。グラフ画面は自前ピンチ + touch-none で自己完結している。
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${archivo.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full">
        {/* 面に質感を出すためのグレイン。暗所での「のっぺり」を消す */}
        <div aria-hidden className="grain" />
        <AppShell>{children}</AppShell>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
