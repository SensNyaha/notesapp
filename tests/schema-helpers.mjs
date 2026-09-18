export function stripSchema13(db){
  db.exec(`
    DROP TABLE IF EXISTS record_attachments;
    DROP TABLE IF EXISTS attachments;
    DROP TABLE IF EXISTS file_uploads;
    PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS collaboration_deliveries;
    DROP TABLE IF EXISTS personal_reminder_configs;
    DROP TABLE IF EXISTS comments;
    DROP TABLE IF EXISTS vault_member_envelopes;
    DROP TABLE IF EXISTS vault_invites;
    DROP TABLE IF EXISTS vault_keyrings;
    DROP TABLE IF EXISTS vault_members;
    DROP TABLE IF EXISTS contacts;
    DROP TABLE IF EXISTS contact_requests;
    DROP TABLE IF EXISTS collaboration_identities;
    DROP INDEX IF EXISTS records_author;
    DROP INDEX IF EXISTS vault_grants_user;
    DROP INDEX IF EXISTS vault_challenges_user;
    ALTER TABLE records DROP COLUMN created_at;
    ALTER TABLE records DROP COLUMN author_user_id;
    ALTER TABLE vault_grants DROP COLUMN user_id;
    ALTER TABLE vault_challenges DROP COLUMN user_id;
    PRAGMA foreign_keys=ON;
  `);
}
