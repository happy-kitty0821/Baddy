import type { Metadata } from "next";
import "./globals.css";
import AuthGuard from "@/components/AuthGuard/AuthGuard";
import NavBar from "@/components/NavBar/NavBar";

export const metadata: Metadata = {
  title: "Badminton AI Coach",
  description: "Personal badminton video analysis and coaching platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        <AuthGuard>
          <NavBar />
          <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>
        </AuthGuard>
      </body>
    </html>
  );
}
