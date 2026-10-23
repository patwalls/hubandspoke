import type { Metadata } from "next";
// Fonts ship from npm (@fontsource), never next/font/google: that one downloads
// from Google mid-build and a single failed fetch fails the deploy (2026-10-23).
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

const fontVars = {
  "--font-sans": "'Inter Variable'",
  "--font-mono": "'JetBrains Mono Variable'",
} as React.CSSProperties;

export const metadata: Metadata = {
  title: {
    template: "%s | Hub & Spoke",
    default: "Hub & Spoke",
  },
  description: "Content Command Center",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  // Edge-to-edge on notched iPhones — the app shell handles its own padding.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      style={fontVars}
    >
      {/* overflow-x-clip (not -hidden): kills page-level horizontal panning on
          mobile without creating a scroll container, so position:sticky inside
          keeps working. Every wide table already has its own overflow-x-auto
          wrapper — nothing becomes unreachable. */}
      <body className="min-h-full flex flex-col font-sans overflow-x-clip">{children}</body>
    </html>
  );
}
