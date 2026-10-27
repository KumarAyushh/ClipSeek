// Runs the SQL files in migrations/ that haven't been run yet.
// Usage: bun run db:migrate
//
// How it remembers: a table `schema_migrations` stores the name of every file already applied.
// Files run in filename order (001_, 002_, ...), each inside its own transaction,
// so a failing migration leaves the database exactly as it was before that file.

import path from "node:path";
import { readdir } from "node:fs/promises";
import { sql } from "@app/shared";

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../migrations");

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql`SELECT name FROM schema_migrations`).map((row: { name: string }) => row.name),
  );

  // .sort() puts 001_ before 002_, which is why files are numbered with leading zeros
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const contents = await Bun.file(path.join(MIGRATIONS_DIR, file)).text();

    // sql.begin = transaction: if anything inside throws, all of it is rolled back
    await sql.begin(async (tx) => {
      // unsafe() runs raw SQL text. Fine here because the text comes from our own files,
      // never from user input. It also allows many statements in one call.
      await tx.unsafe(contents);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });

    console.log(`applied ${file}`);
    ran++;
  }

  console.log(ran === 0 ? "database is up to date" : `done: ${ran} migration(s) applied`);
}

main()
  .catch((err) => {
    console.error("migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => sql.close());
