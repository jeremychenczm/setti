import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { TryPreparationProvider } from "@/ui/try/TryPreparationProvider";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Setti",
  description: "Project chat for interior designers and their clients, with every change and payment in one place.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions (translators, password managers) add attributes to <html> and
    // <body> before React hydrates; ignore those two elements' attribute differences.
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`} suppressHydrationWarning>
        <TryPreparationProvider>{children}</TryPreparationProvider>
      </body>
    </html>
  );
}
