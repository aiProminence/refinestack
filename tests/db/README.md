# Database verification

Run the Release 1 assertions only against an isolated local or branch database after all migrations:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/release1_schema_assertions.sql
```

The hosted Auth configuration is part of the security boundary:

1. Disable public email sign-up.
2. Keep the Before User Created hook pointed at `private.hook_require_beta_invite`.
3. Create `workspace_invitations` first, then call `auth.admin.inviteUserByEmail`.
4. The Auth trigger binds the created user ID to the matching active invitation.
5. The mailbox token establishes the session; only that user can set `accepted_at`.

The hook is an allowlist, not a substitute for disabling public signup. Supabase's hook payload does not identify whether an email user was created by public signup or `inviteUserByEmail`, so both controls are required to prevent an email-only password preclaim.
