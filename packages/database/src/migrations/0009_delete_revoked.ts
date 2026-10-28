import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // A deleted (revoked) agent leaves the panel but not the history that references it (REQ-DB-002):
  // its row and its profiles stay; the name and the Linken Sphere profiles become free to register again.
  await sql`
    ALTER TABLE agents ADD COLUMN deleted_at TIMESTAMPTZ;
    ALTER TABLE agents DROP CONSTRAINT agents_name_key;
    CREATE UNIQUE INDEX agents_name_live ON agents(name) WHERE deleted_at IS NULL;
    ALTER TABLE profiles ADD COLUMN archived_at TIMESTAMPTZ;
    ALTER TABLE profiles DROP CONSTRAINT profiles_provider_external_profile_id_key;
    CREATE UNIQUE INDEX profiles_external_live ON profiles(provider, external_profile_id) WHERE archived_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX profiles_external_live;
    ALTER TABLE profiles ADD CONSTRAINT profiles_provider_external_profile_id_key UNIQUE (provider, external_profile_id);
    ALTER TABLE profiles DROP COLUMN archived_at;
    DROP INDEX agents_name_live;
    ALTER TABLE agents ADD CONSTRAINT agents_name_key UNIQUE (name);
    ALTER TABLE agents DROP COLUMN deleted_at;
  `.execute(db);
}
