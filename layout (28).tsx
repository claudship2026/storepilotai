import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StorePilot AI",
  description: "Human-governed AI operating system for a Shopify store.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
