import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://knowledge_app:devpassword@localhost:5432/knowledge';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: { url: databaseUrl },
  verbose: true,
  strict: true,
});
