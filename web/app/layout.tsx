import type { Metadata, Viewport } from "next";
import { SITE } from "@/content/site";
import { SiteProvider } from "@/components/providers";
import "./globals.css";

const TITLE = "RLPlayer — 업데이트 알림 없는 무료 동영상 플레이어";
const DESCRIPTION =
  "켜면 그냥 영상이 나옵니다. 업데이트 알림도, 광고도, 번들도, 텔레메트리도 없는 오픈소스(MIT) 윈도우 동영상 플레이어. mpv 엔진 내장으로 MKV, HEVC, AV1, DTS, ASS 자막까지 그대로 재생됩니다.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: TITLE,
    template: "%s · RLPlayer",
  },
  description: DESCRIPTION,
  applicationName: SITE.name,
  keywords: [
    "RLPlayer",
    "동영상 플레이어",
    "무료 동영상 플레이어",
    "팟플레이어 대체",
    "PotPlayer 대안",
    "광고 없는 플레이어",
    "오픈소스 플레이어",
    "mpv",
    "MKV 재생",
    "HEVC 플레이어",
    "windows video player",
    "ad-free video player",
  ],
  authors: [{ name: "RLPlayer" }],
  alternates: { canonical: SITE.url },
  openGraph: {
    type: "website",
    url: SITE.url,
    siteName: SITE.name,
    title: TITLE,
    description: DESCRIPTION,
    locale: "ko_KR",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  category: "technology",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090c" },
    { media: "(prefers-color-scheme: light)", color: "#fbfaf8" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Applies a stored theme choice before first paint so the page never flashes.
const THEME_SCRIPT = `try{var t=localStorage.getItem("rlplayer.theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}`;

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE.name,
  applicationCategory: "MultimediaApplication",
  operatingSystem: "Windows 10, Windows 11",
  description: DESCRIPTION,
  url: SITE.url,
  downloadUrl: SITE.download,
  license: "https://opensource.org/licenses/MIT",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        {/* Scroll reveals are JS-driven; without JS everything must still show. */}
        <noscript>
          <style>{".reveal{opacity:1 !important;transform:none !important}"}</style>
        </noscript>
      </head>
      <body className="antialiased">
        <SiteProvider>{children}</SiteProvider>
      </body>
    </html>
  );
}
