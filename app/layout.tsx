import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AVeRA | Class Portal",
  description: "Classroom records and learner progress",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}