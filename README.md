# Chatter

A responsive real-time messaging application built with React, Vite, Supabase Auth, Postgres, Realtime, and Storage.

## What is implemented

- Email/password sign-up and sign-in; sign-in accepts email or username. Supabase Auth handles password hashing, persistent sessions, verification, logout, and password reset.
- Unique usernames and generated Chatter IDs; exact username/ID discovery subject to account privacy.
- Profile editing, profile photos, privacy controls, and light/dark appearance.
- Friend requests, incoming-request actions, contacts, and direct conversations.
- Realtime text messages, typing indicators, replies, message editing/deletion, reactions, forwarding, read receipts, and unread counters.
- Group creation with selected friends, group details, and member lists.
- Private chat-file uploads and public profile photos, with size/type restrictions and Storage policies.
- Realtime activity notifications for messages and incoming friend requests.
- Responsive desktop and mobile layouts.

## Requirements

- Node.js 20 or newer
- A Supabase project

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. In your Supabase project, open **SQL Editor**, paste the contents of [`supabase/schema.sql`](./supabase/schema.sql), and run it using a project owner account.

   If email/password login works but Chatter shows a database setup screen or a `PGRST205` error, the Auth service is connected but the app tables have not been installed. Run this SQL step against the same Supabase project configured in `.env`, then use **Retry database connection** in the app.

3. Install the Supabase CLI, authenticate, link your project, and deploy the Edge Functions:

   ```sh
   supabase login
   supabase link --project-ref your-project-ref
   supabase functions deploy username-login --no-verify-jwt
   supabase functions deploy delete-account
   ```

   The functions use Supabase's `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment values. The service-role key stays server-side in the Edge Functions and must never be added to the frontend. The username-login function delegates password verification to Supabase Auth; the delete-account function requires the caller's authenticated JWT.

4. In **Authentication → URL Configuration**, set the Site URL to your local or deployed application URL and add that URL to the redirect allow list. Configure an email provider and SMTP for production verification and password reset mail.
5. Copy `.env.example` to `.env` and set your project URL and **anon/publishable** key:

   ```env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
   ```

   Never use a Supabase `service_role` key in this frontend.

6. Start the development server:

   ```sh
   npm run dev
   ```

7. Create an account and follow the verification email. For local testing, email confirmation can be configured under Supabase Authentication settings.

## Configuration and deployment

Run `npm run build` to generate the static site in `dist/`. Deploy `dist/` to any static host (for example, Vercel, Netlify, or Cloudflare Pages), set the two `VITE_SUPABASE_*` environment variables in the host, deploy both Edge Functions, and configure the Supabase Site URL and redirect allow list to your production domain. The host should serve `index.html` for the root route.

### GitHub Pages

The included GitHub Actions workflow automatically builds and deploys the app when a commit is pushed to `main` or `master`—including commits made by uploading files through GitHub. Upload the project source (not `node_modules`, `.env`, or `dist`) and keep `package.json`, `package-lock.json`, and `index.html` together in the repository root or in one uploaded project folder. The workflow locates that project folder and can move root-level `App.jsx`, `main.jsx`, and `styles.css` into `src/` when needed.

Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository Actions secrets under **Settings → Secrets and variables → Actions**. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. The build uses the correct asset path for a project page (for example, `owner.github.io/repository/`) or a user/organization page (`owner.github.io/`). After deployment, add the GitHub Pages URL to the Supabase Auth site's URL and redirect allow list.

The project SQL installs the database tables, indexes, profile/signup triggers, private username lookup table for the Edge Function, RPCs, notifications, storage buckets, realtime publication entries, and row-level security policies. Review and test schema changes in a non-production Supabase project before deploying them to production.

## Notes and current boundaries

- Supabase must be configured before the app can authenticate or access data. The source does not include credentials or a hosted backend.
- Email verification and reset delivery depend on the Supabase Auth provider and SMTP configuration.
- Browser notifications work while the app is open and permission is granted; background Web Push notifications and message sounds are not included. Group photos and a separate accept/decline flow for group invitations are not exposed in this initial UI.
- Private attachment downloads use short-lived signed URLs and Storage RLS; chat files are not publicly readable.
- Add rate limits and production email controls in Supabase Auth, configure backups, and validate deployment redirect URLs before launch.
