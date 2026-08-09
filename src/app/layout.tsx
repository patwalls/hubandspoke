import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

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
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      {/* overflow-x-clip (not -hidden): kills page-level horizontal panning on
          mobile without creating a scroll container, so position:sticky inside
          keeps working. Every wide table already has its own overflow-x-auto
          wrapper — nothing becomes unreachable. */}
      <body className="min-h-full flex flex-col font-sans overflow-x-clip">{children}</body>
    </html>
  );
}
