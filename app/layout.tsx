// TARGET: app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Rajdhani, Mulish, Inter } from "next/font/google";
import "./globals.css";
import TeamHub from "./components/TeamHub";
import ServiceWorkerRegister from "./components/ServiceWorkerRegister";
import InstallPrompt from "./components/InstallPrompt";
import LoginAudit from './components/LoginAudit';

// Inter es ahora la tipografía principal del sistema (overhaul navy 2026-06).
// Se mantienen Rajdhani y Mulish disponibles para no romper estilos por página
// que aún referencien --font-rajdhani / --font-mulish; se migran en el pulido.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const rajdhani = Rajdhani({
  variable: "--font-rajdhani",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const mulish = Mulish({
  variable: "--font-mulish",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

// ─── PWA metadata ──────────────────────────────────────────────────────────
// Phase 3 (2026-05-13): adds manifest, icons, theme color, and Apple-specific
// touch icon. No service worker yet — that comes later for offline support.
//
// `manifest` → links /manifest.webmanifest, which references /icons/* PNGs.
// `appleWebApp.capable` → fullscreen launch when opened from iOS home screen.
// `appleWebApp.statusBarStyle: 'black-translucent'` → status bar tints to
// match the page background instead of forcing iOS default.
// ───────────────────────────────────────────────────────────────────────────
export const metadata: Metadata = {
  title: "Motocentro Tesorería — AutoCore NPA",
  description: "Sistema de cobros, ingresos y tesorería de Motocentro II — KIA Maracay.",
  manifest: "/manifest.webmanifest",
  applicationName: "Motocentro Tesorería",
  appleWebApp: {
    capable: true,
    title: "Tesorería",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

// `themeColor` is a Viewport export in Next 15 (was previously on Metadata).
// Controls the Android status bar tint and Chrome's address bar color.
// Navy-charcoal page background to match the dark theme chrome.
export const viewport: Viewport = {
  themeColor: "#0B0E14",
  width: "device-width",
  initialScale: 1,
  // PWAs typically lock zoom to feel more app-like. Leave maximumScale alone
  // for accessibility — users with low vision still need pinch-zoom.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" data-theme="dark">
      <body className={`${inter.variable} ${rajdhani.variable} ${mulish.variable}`}>
        {children}
        <TeamHub app="npa" />
        <ServiceWorkerRegister />
        <InstallPrompt />
        <LoginAudit />
      </body>
    </html>
  );
}