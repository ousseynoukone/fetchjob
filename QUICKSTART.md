# Quick Start Guide - FindUrJob Clone

## 🚀 Get Up and Running in 5 Minutes

### Prerequisites
- Node.js 18+ ([Download](https://nodejs.org/))
- Docker & Docker Compose ([Download](https://www.docker.com/products/docker-desktop))
- Git

### Step 1: Initialize Git Repository

```bash
cd findurjob-clone
git init
git add .
git commit -m "feat: initial project structure"
```

### Step 2: Install Dependencies

```bash
npm install
```

This installs dependencies for the entire monorepo (apps/web, apps/api, packages, workers).

### Step 3: Start Services

```bash
docker-compose up -d
```

This starts:
- PostgreSQL database (port 5432)
- Redis (port 6379)

Verify services are running:
```bash
docker-compose ps
```

### Step 4: Initialize Database

```bash
cd apps/api
npx prisma migrate dev
npx prisma generate
cd ../..
```

### Step 5: Start Development Servers

```bash
npm run dev
```

This starts both frontend and backend in development mode.

## 🌐 Access Applications

| App | URL | Port |
|-----|-----|------|
| Frontend | http://localhost:3000 | 3000 |
| Backend API | http://localhost:4000/api | 4000 |

## 📁 Project Structure

```
findurjob-clone/
├── apps/
│   ├── web/              # React/Next.js Frontend
│   └── api/              # NestJS Backend API
├── packages/             # Shared packages (soon)
├── workers/              # Background jobs (soon)
└── docker-compose.yml    # Local dev services
```

## 🛠️ Common Commands

### Development
```bash
npm run dev              # Start all servers in watch mode
npm run build            # Build frontend & backend
npm run lint             # Lint all code
npm run type-check       # TypeScript validation
npm run test             # Run tests
npm run format           # Format code with Prettier
```

### Frontend (apps/web)
```bash
npm run dev              # Start Next.js dev server
npm run build            # Build for production
npm start                # Run production build
```

### Backend (apps/api)
```bash
npm run dev              # Start NestJS with watch
npm run build            # Build NestJS
npm start                # Run production build
npm run test             # Run tests
```

### Database
```bash
cd apps/api
npx prisma studio       # Open Prisma Studio GUI
npx prisma generate     # Generate Prisma client
npx prisma migrate dev  # Run migrations
npx prisma migrate reset # Reset database
```

## 🐳 Docker Management

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f

# Reset everything
docker-compose down -v
docker-compose up -d
```

## 📋 Development Phases

### Phase 1: Foundation (Next)
- [ ] Prisma database schema
- [ ] Auth module (JWT, OAuth)
- [ ] CV module CRUD
- [ ] CV Builder UI

### Phases 2-7
See main README.md for full roadmap

## 🆘 Troubleshooting

### Ports Already in Use
```bash
# Find and kill process on port
lsof -i :3000           # Frontend
lsof -i :4000           # Backend
lsof -i :5432           # PostgreSQL
lsof -i :6379           # Redis
```

### Database Connection Issues
```bash
# Check PostgreSQL is running
docker-compose logs postgres

# Reset database
cd apps/api
npx prisma migrate reset
```

### Node Modules Issues
```bash
# Clean install
rm -rf node_modules
npm install
```

## 📚 Documentation

- [README.md](./README.md) - Project overview
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guide
- [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) - Detailed structure
- [apps/web/README.md](./apps/web/README.md) - Frontend docs
- [apps/api/README.md](./apps/api/README.md) - Backend docs

## 🎯 Next Steps

1. ✅ Project structure created
2. ⏭️ **Next**: Create Prisma schema for Phase 1
3. ⏭️ Implement Auth module
4. ⏭️ Build CV module and UI

## 💡 Tips

- Use `npm run dev` to develop both frontend and backend simultaneously
- Check browser console and terminal for errors
- Use Prisma Studio (`npx prisma studio`) to inspect database
- Read comments in code for context and next steps

## 🤝 Need Help?

- Check [CONTRIBUTING.md](./CONTRIBUTING.md) for setup issues
- Review error messages carefully
- Check Docker logs: `docker-compose logs`
- Check console output from `npm run dev`

---

**Happy coding! 🚀**

Start Phase 1 when ready: Create Prisma schema and Auth module
