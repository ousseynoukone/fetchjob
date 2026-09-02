# FindUrJob Clone 🚀

An AI-powered automated job application platform that scrapes job offers, matches them with your CV, adapts your application materials, and applies automatically.

## Features

- 🤖 **AI-Powered Matching**: Semantic matching between CV and job offers
- 📄 **CV Builder**: Beautiful, editable CV with live preview
- 🎯 **Smart Filtering**: Multiple job sources (France Travail, Adzuna, LinkedIn)
- ✍️ **AI-Generated Applications**: Automatic CV adaptation and cover letter generation
- 📊 **Campaign Management**: Track and manage job applications
- 🔐 **OAuth Integration**: LinkedIn, Google authentication
- 💳 **Stripe Integration**: Free, Premium, and Pro plans

## Tech Stack

### Frontend
- **React 18** + **Next.js 14** - Framework
- **TypeScript** - Type safety
- **Tailwind CSS + DaisyUI** - Styling
- **React Hook Form** - Form management
- **TanStack Query** - Data fetching
- **Zustand** - State management

### Backend
- **Node.js** + **NestJS** - API framework
- **PostgreSQL** - Database
- **Redis + BullMQ** - Job queue
- **Prisma** - ORM
- **OpenAI API** - AI features
- **Stripe** - Payments

### DevOps
- **Docker + Docker Compose** - Containerization
- **GitHub Actions** - CI/CD
- **Turborepo** - Monorepo management

## Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- PostgreSQL (or use Docker)
- Redis (or use Docker)

### Installation

1. **Clone repository**
```bash
git clone https://github.com/yourusername/findurjob-clone.git
cd findurjob-clone
```

2. **Install dependencies**
```bash
npm install
```

3. **Setup environment**
```bash
cp .env.example .env.local
# Edit .env.local with your credentials
```

4. **Start services with Docker**
```bash
docker-compose up -d
```

5. **Initialize database**
```bash
cd apps/api
npx prisma migrate dev
```

6. **Start development servers**
```bash
npm run dev
```

- Frontend: http://localhost:3000
- Backend: http://localhost:4000
- Docs: http://localhost:4000/api

## Project Structure

```
findurjob-clone/
├── apps/
│   ├── web/              # Next.js frontend
│   └── api/              # NestJS backend
├── packages/             # Shared packages
├── workers/              # Background job workers
├── .github/
│   ├── workflows/        # CI/CD pipelines
│   └── pull_request_template.md
├── docker-compose.yml
└── README.md
```

## Development Phases

### Phase 1: Foundation (2 weeks)
- [ ] Setup monorepo
- [ ] Authentication (JWT, OAuth)
- [ ] CV module & database
- [ ] CV Builder UI

### Phase 2: PDF Generation (1 week)
- [ ] PDF template system
- [ ] Server-side PDF generation
- [ ] Live preview

### Phase 3: Scraping & Matching (2 weeks)
- [ ] API integrations (France Travail, Adzuna)
- [ ] Semantic matching algorithm
- [ ] Job queue setup

### Phase 4: AI Features (1 week)
- [ ] CV adaptation
- [ ] Cover letter generation
- [ ] Offer analysis

### Phase 5: Campaigns (1 week)
- [ ] Campaign UI
- [ ] Manual & automatic triggering
- [ ] Applications dashboard

### Phase 6: Integrations & Payments (1 week)
- [ ] OAuth LinkedIn
- [ ] Stripe integration
- [ ] Email notifications

### Phase 7: Polish & Deploy (1 week)
- [ ] Dashboard & statistics
- [ ] Mobile responsiveness
- [ ] Tests & CI/CD
- [ ] Production deployment

## API Documentation

### Authentication
```bash
POST /auth/register
POST /auth/login
POST /auth/refresh
GET  /auth/linkedin
GET  /auth/google
```

### CV Management
```bash
GET    /cv
PUT    /cv
POST   /cv/pdf
POST   /cv/adapt
```

### Campaigns
```bash
GET    /campaign
POST   /campaign/run
POST   /campaign/pause
GET    /campaign/stats
```

### Applications
```bash
GET    /applications
GET    /applications/:id
PATCH  /applications/:id/status
POST   /applications/:id/apply
```

## Contributing

1. Create a feature branch (`git checkout -b feature/amazing-feature`)
2. Commit changes (`git commit -m 'Add amazing feature'`)
3. Push to branch (`git push origin feature/amazing-feature`)
4. Open a Pull Request

## License

MIT

## Support

For issues and feature requests, please use GitHub Issues.

---

**Built with ❤️ for job seekers worldwide**
