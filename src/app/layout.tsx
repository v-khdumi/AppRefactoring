import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import "./globals.css";
import "./theme.css";
import "./architecture.css";
import { AuthProvider } from "@/components/auth-provider";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ModernizeAI · Software modernization intelligence",
  description: "Controlled analysis and modernization of legacy applications with Microsoft Foundry.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><AuthProvider allowLocalDemo={process.env.DEMO_MODE==="true"}>{children}</AuthProvider></body>
    </html>
  );
}