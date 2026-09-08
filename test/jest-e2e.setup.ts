import { execSync } from 'node:child_process';

// Global setup (LLD §13.1): apply migrations once against the test DB before any
// e2e spec runs. Expects docker-compose.test.yml services to be up and the test
// DATABASE_URL / REDIS_URL exported (see README).
export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
}
