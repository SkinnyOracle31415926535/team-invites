# Team Invitations

A private, browser-local web app for creating and tracking NGA and USAG team invitations.

## Use

Open the published GitHub Pages app, choose NGA or USAG, and create an invitation. Program Setup stores reusable schedule and cost details for each program. Each athlete can also have an optional private NGA or USAG skill checklist. Moving Forward fields appear when an invitation is Invited or Accepted. Hide Fields lets a coach remove unneeded fields from one athlete's editor and finished invitation without deleting the saved values. The app can print an invitation or copy its text.

## Privacy and private sync

Athlete records are never committed to this repository. The app always keeps an offline copy in the browser under `team-invites-v1`; private notes and checklists are not included in printed or copied invitations.

For the same records on every device, connect the app to a private Supabase project and sign in with the same email/password on each device. The app sends records only to that project over HTTPS. Its public project URL and publishable/anon key can be stored in the app; never enter a Supabase service-role or secret key. Row Level Security (RLS) limits every signed-in account to its own row.

### One-time Supabase setup

1. Create a private Supabase project, then copy its **Project URL** and **Publishable** (or legacy **anon**) key from the project's API settings.
2. In the project's SQL Editor, run this once:

```sql
create table public.team_invitation_states (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

grant usage on schema public to authenticated;
grant select, insert, update on public.team_invitation_states to authenticated;

alter table public.team_invitation_states enable row level security;

create policy "Users can read their own invitation state"
on public.team_invitation_states
for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own invitation state"
on public.team_invitation_states
for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own invitation state"
on public.team_invitation_states
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
```

3. In Supabase Auth settings, keep email/password sign-in enabled. If email confirmation is enabled, set the Site URL to this app's published URL and confirm the signup email before signing in.
4. Open **Private Sync** in the app, paste the Project URL and publishable/anon key, then create an account or sign in. Repeat the sign-in on the iPad and any other device.

When the cloud copy is newer, the app restores it and first keeps a browser-local backup. Otherwise it uploads the current device copy. If two devices edit offline, the newest saved copy becomes the shared version when either device reconnects.


## Typography

The app bundles STIX Two Text italic font files from Fontsource. STIX is licensed under the SIL Open Font License 1.1; the license is included at `assets/fonts/OFL.txt`.
