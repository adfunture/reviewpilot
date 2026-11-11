import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReviewPilot",
  description: "Bewertungsanfragen für Shopify zentral steuern",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body className="antialiased">{children}</body>
    </html>
  );
}
