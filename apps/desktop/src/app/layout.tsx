import type { Metadata } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "next-themes";
import { ExternalLinkHandler } from "@/components/external-link-handler";
import { ToastProvider } from "@/components/ui/toast";
import { WorkbenchLocaleBridge } from "@/components/workbench-locale";
import "./globals.css";

// Bundled (SIL OFL 1.1, see ./fonts) so builds never fetch from Google Fonts.
const modernSans = localFont({
  src: "./fonts/roboto-latin.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  weight: "100 900",
});

const modernMono = localFont({
  src: "./fonts/roboto-mono-latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 700",
});

export const metadata: Metadata = {
  title: "Y-Writer",
  description: "AI-native LaTeX editor",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${modernSans.variable} ${modernMono.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
          <WorkbenchLocaleBridge>
            <ToastProvider>
              <ExternalLinkHandler />
              {children}
            </ToastProvider>
          </WorkbenchLocaleBridge>
        </ThemeProvider>
      </body>
    </html>
  );
}
