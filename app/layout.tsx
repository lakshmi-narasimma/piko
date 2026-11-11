import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Piko",
  description: "Piko makes PayPal the default way AI agents pay, and get paid.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <Suspense fallback={<div className="h-[53px] border-b border-line" />}>
          <SiteHeader />
        </Suspense>
        <div className="flex flex-1 flex-col">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
