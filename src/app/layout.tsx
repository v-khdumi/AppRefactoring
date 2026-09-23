import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import "./theme.css";
import "./architecture.css";
import { AuthProvider } from "@/components/auth-provider";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  title: "ModernizeAI · Software modernization intelligence",
  description: "Controlled analysis and modernization of legacy applications with Microsoft Foundry.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={manrope.variable}><AuthProvider>{children}</AuthProvider></body>
    </html>
  );
}