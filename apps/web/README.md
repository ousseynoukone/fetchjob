# Frontend Application

Next.js 14 React frontend for FindUrJob with TypeScript, Tailwind CSS, and DaisyUI.

## Features

- 🎨 Beautiful, responsive UI with dark mode
- 🏗️ App Router with layouts
- 🔐 Authentication pages (login, register)
- 📄 CV Builder with live preview
- 🎯 Campaign management
- 📋 Applications dashboard
- 📱 Mobile responsive

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
app/
├── (auth)/          # Authentication routes
├── (dashboard)/     # Protected dashboard routes
├── layout.tsx       # Root layout
├── page.tsx         # Home page
└── globals.css      # Global styles

components/
├── cv-builder/      # CV builder components
├── campaign/        # Campaign management
├── applications/    # Applications list and detail
└── ui/              # Reusable UI components

lib/
├── api.ts           # API client
├── store.ts         # Zustand store
└── types.ts         # TypeScript types
```

## Tech Stack

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- DaisyUI
- React Hook Form
- TanStack Query
- Zustand

## Environment Variables

See `.env.local` for required variables.
