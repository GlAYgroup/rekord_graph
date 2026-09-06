"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  PerformanceBar, PerformanceProvider, PerformanceToggle, usePerformance,
} from "@/components/PerformanceMode";

/**
 * 全ページ共通のナビ。
 * PC = 左レール（Obsidian の作法。グラフを全画面にしても常に見えている）
 * スマホ = 下タブ（親指の届く位置）
 */
const TABS = [
  {
    href: "/",
    label: "曲",
    match: (p: string) => p === "/" || p.startsWith("/track"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <circle cx="12" cy="12" r="8.2" />
        <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: "/graph",
    label: "グラフ",
    match: (p: string) => p.startsWith("/graph"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="9" r="2.6" /><circle cx="9" cy="18" r="2.6" />
        <path d="M8.3 7.2 15.6 8.6M7 15.7 6.4 8.6M11.4 16.9l4.6-5.8" />
      </svg>
    ),
  },
  {
    href: "/new",
    label: "入力",
    match: (p: string) => p.startsWith("/new"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <circle cx="12" cy="12" r="8.6" />
        <path d="M12 8.2v7.6M8.2 12h7.6" />
      </svg>
    ),
  },
  {
    href: "/chain",
    label: "チェーン",
    match: (p: string) => p.startsWith("/chain"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <path d="M9.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.6l-1.2 1.2" />
        <path d="M14.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.6l1.2-1.2" />
      </svg>
    ),
  },
  {
    href: "/practice",
    label: "練習",
    match: (p: string) => p.startsWith("/practice"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <path d="M6 21V4" />
        <path d="M6 4.5h11.5l-2.6 4 2.6 4H6" />
      </svg>
    ),
  },
  {
    // プレイ中に開く画面。本番の切り替えの隣 = 親指がいちばん届く側に置く
    href: "/play",
    label: "プレイ",
    match: (p: string) => p.startsWith("/play"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <rect x="3" y="4.5" width="12" height="5" rx="1.6" />
        <rect x="3" y="14.5" width="12" height="5" rx="1.6" />
        <path d="M18 8.5v7M18 15.5l-2.2-2.4M18 15.5l2.2-2.4" />
      </svg>
    ),
  },
  {
    href: "/health",
    label: "状態",
    match: (p: string) => p.startsWith("/health"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
        <path d="M3 12h4l2.5-6 4 12L16 12h5" />
      </svg>
    ),
  },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PerformanceProvider>
      <Shell>{children}</Shell>
    </PerformanceProvider>
  );
}

/**
 * ナビと中身。パフォーマンスモードは `data-perf` としてここに出す
 * （`globals.css` が `[data-perf="on"] [data-edit]` を消す = サーバで描いた画面も畳める）。
 */
function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { on: performing } = usePerformance();
  return (
    <div className="md:pl-16" data-perf={performing ? "on" : undefined}>
      <PerformanceBar />
      {/* PC: 左レール */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-16 flex-col items-center border-r border-border bg-bg-deep/80 backdrop-blur-md md:flex">
        <Link
          href="/"
          className="mt-4 mb-2 grid size-9 place-items-center rounded-pad bg-linear-to-b from-elevated to-surface font-mono text-[13px] font-semibold text-accent border border-border-bright"
          aria-label="rekord_graph ホーム"
        >
          rg
        </Link>
        <ul className="mt-2 flex flex-col gap-1">
          {TABS.map((t) => {
            const active = t.match(pathname);
            return (
              <li key={t.href} className="relative" {...(t.href === "/new" ? { "data-edit": "" } : {})}>
                {active && (
                  <span className="absolute -left-[13px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
                )}
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-14 flex-col items-center gap-1 rounded-lg py-2.5 transition-colors ${
                    active ? "text-accent" : "text-fg-subtle hover:text-fg-muted hover:bg-surface"
                  }`}
                >
                  {t.icon}
                  <span className="text-[10px] tracking-wide">{t.label}</span>
                </Link>
              </li>
            );
          })}
          {/* 本番の切り替え。押すたびに編集の入口が畳まれる / 戻る */}
          <li className="mt-1 border-t border-border pt-1">
            <PerformanceToggle variant="rail" />
          </li>
        </ul>
      </aside>

      {children}

      {/*
        スマホ: 下タブ。
        高さは `--nav-h` が正本（グラフのキャンバスと各ページの下余白が同じ値を見ている）。
        中身は下端から浮かせる: 画面の最下部は iOS のホームインジケータと
        下スワイプのジェスチャ帯なので、そこに置いたボタンは1回目のタップが吸われる。
      */}
      <nav className="fixed inset-x-0 bottom-0 z-30 min-h-[var(--nav-h)] border-t border-border bg-bg/90 pb-[max(env(safe-area-inset-bottom,0px),12px)] backdrop-blur-md md:hidden">
        <ul className="flex">
          {TABS.map((t) => {
            const active = t.match(pathname);
            return (
              <li key={t.href} className="flex-1" {...(t.href === "/new" ? { "data-edit": "" } : {})}>
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`tap flex flex-col items-center justify-center gap-0.5 py-2 ${
                    active ? "text-accent" : "text-fg-subtle"
                  }`}
                >
                  {t.icon}
                  <span className="text-[10px] tracking-wide">{t.label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <PerformanceToggle variant="tab" />
          </li>
        </ul>
      </nav>
    </div>
  );
}
