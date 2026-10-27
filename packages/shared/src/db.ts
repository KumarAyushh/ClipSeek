// The one Postgres connection pool shared by the API, the workers and scripts.
// We use Bun's built-in client (no ORM, no extra dependency) and write plain SQL.

import { SQL } from "bun";
import { config } from "./config";

// `sql` is used as a tagged template:
//   const rows = await sql`SELECT * FROM videos WHERE id = ${id}`;
// Each ${value} is sent to Postgres as a separate parameter, not glued into the
// SQL text, so user input can never change the query (no SQL injection).
// The client keeps a pool of connections open and reuses them between queries.
export const sql = new SQL(config.databaseUrl);
