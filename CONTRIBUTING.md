# Contributing to FindUrJob

We love your input! We want to make contributing to this project as easy and transparent as possible.

## Development Setup

1. **Fork and clone the repository**
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
# Edit .env.local with your local configuration
```

4. **Start Docker services**
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

## Workflow

1. Create a feature branch (`git checkout -b feature/amazing-feature`)
2. Make your changes
3. Run tests and linting:
   ```bash
   npm run test
   npm run lint
   npm run type-check
   ```
4. Commit with clear messages (`git commit -m 'feat: add amazing feature'`)
5. Push to your fork (`git push origin feature/amazing-feature`)
6. Open a Pull Request

## Code Style

- Use TypeScript for type safety
- Follow the existing code structure
- Run `npm run format` to auto-format code
- Write meaningful commit messages
- Add tests for new features

## Commit Messages

Follow Conventional Commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation
- `style:` for formatting
- `refactor:` for code restructuring
- `test:` for tests
- `chore:` for maintenance

Example: `feat: add CV adaptation for job offers`

## Pull Request Process

1. Update README.md with any new features or changes
2. Ensure all tests pass
3. Include description of changes
4. Link related issues
5. Request review from maintainers

## Report Bugs

Use GitHub Issues to report bugs. Include:
- Clear description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)

## Feature Requests

Create a GitHub Issue with:
- Clear title and description
- Use cases
- Potential implementation ideas

## Questions?

- Check existing issues and PRs
- Read the README and documentation
- Join our discussions

Thank you for contributing! 🎉
