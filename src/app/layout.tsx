import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { TryPreparationProvider } from "@/ui/try/TryPreparationProvider";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

/**
 * Browser translators replace text nodes with their own elements. When React later
 * updates that text (a button label after a payment, a status line appearing), the
 * node it expects is gone and insertBefore/removeChild throw, which crashes the page.
 * Before React starts, make those two calls tolerate a node a translator moved:
 * insert at the end instead, or remove it from wherever it now is.
 */
const TRANSLATION_GUARD = `(function () {
  if (typeof Node === "undefined" || window.__settiTranslationGuard) return;
  window.__settiTranslationGuard = true;
  var removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child.parentNode !== this) return child.parentNode ? removeChild.call(child.parentNode, child) : child;
    return removeChild.call(this, child);
  };
  var insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, reference) {
    if (reference && reference.parentNode !== this) return insertBefore.call(this, node, null);
    return insertBefore.call(this, node, reference);
  };
})();`;

export const metadata: Metadata = {
  title: "Setti",
  description: "Project chat for interior designers and their clients, with every change and payment in one place.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions (translators, password managers) add attributes to <html> and
    // <body> before React hydrates; ignore those two elements' attribute differences.
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: TRANSLATION_GUARD }} /></head>
      <body className={`${inter.variable} antialiased`} suppressHydrationWarning>
        <TryPreparationProvider>{children}</TryPreparationProvider>
      </body>
    </html>
  );
}
