process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

function cleanupOrphanedPlaywrightProcesses() {
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync(
        `powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
        { stdio: 'ignore' },
      );
    } catch {}
  }
}

// Ensure orphaned Chromium processes are cleaned up on shutdown
process.on('SIGINT', () => {
  cleanupOrphanedPlaywrightProcesses();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupOrphanedPlaywrightProcesses();
  process.exit(0);
});
process.on('beforeExit', () => {
  cleanupOrphanedPlaywrightProcesses();
});

async function bootstrap() {
  // Purge any stale orphaned Playwright Chromium instances left from previous crashes
  cleanupOrphanedPlaywrightProcesses();

  const app = await NestFactory.create(AppModule);

  // Enable shutdown hooks so that services (like BrowserSessionService) 
  // can properly close their Playwright instances when the app stops or restarts
  app.enableShutdownHooks();

  // Enable CORS
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ].filter(Boolean) as string[];

  app.enableCors({
    origin: (origin, callback) => {
      // allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive in dev/local
      }
    },
    credentials: true,
    // The API and the web app are on different ports, so the browser hides
    // every response header from the frontend unless it is listed here. The
    // PDF endpoints already name their file in Content-Disposition, and
    // without this the download code cannot read it and has to invent a name
    // of its own.
    exposedHeaders: ['Content-Disposition'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API prefix
  app.setGlobalPrefix('api');

  const port = process.env.PORT || 4000;
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Application is running on: http://localhost:${port}/api`);
}

bootstrap();
