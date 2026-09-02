import type { Metadata } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';
import ToastContainer from '@/components/ui/toast-container';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const sourceSerif = Source_Serif_4({ subsets: ['latin'], variable: '--font-source-serif' });

export const metadata: Metadata = {
  title: 'FindUrJob - AI-Powered Job Application',
  description: 'Automate your job search with AI-powered CV matching and applications',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="findurjob" className={`${inter.variable} ${sourceSerif.variable}`}>
      <body className="font-sans">
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
