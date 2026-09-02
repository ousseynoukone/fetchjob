# Backend API

NestJS API server for FindUrJob with PostgreSQL, Redis, and job queues.

## Features

- 🔐 JWT authentication with OAuth support
- 💾 PostgreSQL database with Prisma ORM
- 📅 Redis caching and job queue (BullMQ)
- 🤖 OpenAI integration for AI features
- 🎯 Job matching algorithm
- 🕷️ Web scraping capabilities
- 💳 Stripe payment integration
- 📧 Email notifications

## Quick Start

```bash
npm install

# Run database migrations
npx prisma migrate dev

# Start development server
npm run dev
```

API runs on [http://localhost:4000/api](http://localhost:4000/api)

## Project Structure

```
src/
├── auth/            # Authentication module
├── cv/              # CV management module
├── campaign/        # Campaign management
├── applications/    # Job applications
├── matching/        # Matching algorithm
├── scraping/        # Web scraping
├── ai/              # AI features
├── payments/        # Stripe integration
├── pdf/             # PDF generation
├── common/          # Shared utilities
└── main.ts          # Entry point
```

## Modules

### Auth Module
- User registration and login
- JWT token management
- OAuth (LinkedIn, Google)
- Password reset

### CV Module
- CRUD operations for CVs
- PDF generation
- CV adaptation for job offers

### Campaign Module
- Campaign CRUD
- Campaign execution
- Job scraping triggers
- Statistics

### Applications Module
- Application management
- Status tracking
- AI-generated cover letters
- Offer analysis

## Database Setup

```bash
# Create migration
npx prisma migrate dev --name add_feature

# Reset database
npx prisma migrate reset

# Generate Prisma client
npx prisma generate
```

## Environment Variables

See `.env.local` for required variables.

## Testing

```bash
npm run test
npm run test:cov
npm run test:e2e
```

## Tech Stack

- NestJS
- TypeScript
- PostgreSQL
- Redis
- Prisma ORM
- OpenAI API
- BullMQ
- Stripe SDK
