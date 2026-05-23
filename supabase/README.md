# Supabase Setup for Lia

## 1. Create a Supabase project

Go to https://supabase.com → New Project. Note your **Project URL** and **anon public key** (Settings → API).

## 2. Run the SQL migrations

In the Supabase dashboard → SQL Editor, run these files in order:

1. `01_licensing.sql` — users table, credit functions, RLS
2. `02_inspections.sql` — ladder inspection records + public view

## 3. Create user accounts

Each tech gets an account. In Supabase:

1. **Auth → Users → Invite user** — enter their email. They receive a magic-link to set their password.
2. Copy their **UUID** from the Auth users table.
3. In SQL Editor, run:
   ```sql
   SELECT create_lia_user(
     'paste-uuid-here',
     'tech@company.com',
     'Tech Name',
     10   -- number of import credits (use -1 for unlimited)
   );
   ```

## 4. Adjust credit balances

In **Table Editor → users**, find the user and edit the `credits` column directly.  
`-1` = unlimited, `0` = blocked, any positive number = that many imports left.

## 5. Add Supabase config to Lia

In `config.json` (next to the Lia app), add:

```json
{
  "username": "bsi-username",
  "password": "bsi-password",
  "supabase": {
    "url": "https://your-project.supabase.co",
    "anonKey": "eyJ..."
  }
}
```

The anon key is safe to store here — RLS prevents users from reading or writing other users' data.

## 6. Inspection report website

After running `02_inspections.sql`, build the S3 static site:

1. Open `inspection-site/index.html`
2. Replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` with your values
3. Upload `index.html` to an S3 bucket with static website hosting enabled
4. Share the S3 website URL — anyone with the link can look up ladders by serial number

To add an inspection record from the Supabase dashboard:
**Table Editor → inspections → Insert row**
