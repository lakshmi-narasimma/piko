import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Piko",
  description: "Piko makes PayPal the default way AI agents pay, and get paid.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
