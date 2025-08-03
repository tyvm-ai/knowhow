import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Benchmark Results Leaderboard',
  description: 'Exercise results and model performance tracking',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}