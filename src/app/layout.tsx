import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MLBB Draft Counter",
  description: "Pick counter suggestions for Mobile Legends tournament drafting",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="bg-purple-950">
      <body className="text-purple-50">{children}</body>
    </html>
  );
}

