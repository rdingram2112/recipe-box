# Putting Our Recipe Box online (free)

When you're done, the app lives at `https://YOURNAME.github.io/recipe-box/`, where YOURNAME is your GitHub username. It works on any phone, tablet or computer, whether or not this PC is on. You and your wife each sign in and see the same recipes and the same shopping list.

It uses two free services, the same pair as Music Rater:
- **GitHub Pages** hosts the website.
- **Supabase** stores the recipes, prices and list, handles sign-in, and runs the small function that reads recipe links.

Plan on about 20 minutes. If you've already set up Git and GitHub for Music Rater, skip step 4.

---

## 1. Create the Supabase project (about 5 minutes)

1. Go to **supabase.com** and sign in. Use the same account as Music Rater if you made one.
2. Click **New project**. Name it `recipe-box`, set a database password (you won't need it again), pick the region **East US** or **Central US**, and click **Create**. It takes a minute or two to finish.
   - The free plan allows 2 active projects, so this fits next to Music Rater.
3. In the left menu, open **SQL Editor → New query**.
4. Open `supabase.sql` from this folder, copy all of it, and paste it in.
5. **Change the two emails** near the top (`you@example.com`, `wife@example.com`) to the emails you'll each sign in with.
6. Click **Run**. You should see "Success. No rows returned."

To add or change a household email later, run this in the SQL Editor:
```sql
insert into public.household_members (email) values ('someone@example.com');
```

## 2. Add the link reader (about 3 minutes)

This is what lets a phone paste a recipe link.

1. In Supabase's left menu, open **Edge Functions**.
2. Click **Deploy a new function** and choose **Via Editor**.
3. Name it exactly `import-recipe`.
4. Delete the sample code. Open `supabase/functions/import-recipe/index.ts` from this folder, then copy and paste all of it.
5. Click **Deploy function**. Leave "Verify JWT" turned **on**, so only signed-in household members can use it.

## 3. Copy two settings into the app

1. In Supabase, open **Project Settings → API** (in newer dashboards it's called **Data API** or **API Keys**).
2. Copy the **Project URL** and the **anon / publishable** key. Don't copy the `service_role` or secret key.
3. Paste them into `config.js` in this folder, or just paste them to Claude in chat and it will fill them in.

These two values are designed to be public. Your data is protected by the household list from step 1.

## 4. Git and GitHub (skip if done for Music Rater)

1. Create a free account at **github.com** if you don't have one.
2. Open PowerShell and install Git and the GitHub command-line tool:
   ```powershell
   winget install --id Git.Git -e
   ```
   ```powershell
   winget install --id GitHub.cli -e
   ```
3. Close and reopen PowerShell, then sign in once:
   ```powershell
   gh auth login
   ```
   Choose **GitHub.com → HTTPS → Login with a web browser** and follow the prompts.

## 5. Publish the site

Tell Claude in chat: **"Publish the recipe box to GitHub Pages."** Claude creates a `recipe-box` repository, uploads these files and turns on GitHub Pages. After that, ask Claude for changes any time and it publishes the update.

GitHub Pages is free for public repositories. The code is public, but your recipes and list are **not**: they live in Supabase behind sign-in.

## 6. Point sign-up emails at the site

1. In Supabase, open **Authentication → URL Configuration**.
2. Set **Site URL** to `https://YOURNAME.github.io/recipe-box/`, then save.

Without this, the "confirm your email" link points at the wrong place.

## 7. Sign in on each phone

1. Open `https://YOURNAME.github.io/recipe-box/`.
2. Tap **Create account** with your household email and a password, click the confirmation email, then sign in.
3. Add it to your home screen so it opens like an app:
   - **iPhone/iPad:** Safari → Share → **Add to Home Screen**.
   - **Android:** Chrome → ⋮ menu → **Add to Home screen**.

Your wife does the same with her email.

---

## Adding another household (for example, a sister)

Everyone on the member list shares the recipes and prices. Each **household** has its own weekly shopping list.

1. If you haven't yet, run `supabase-update-2-households.sql` once in the SQL Editor. Put your sister's email in it before you run it.
2. To add more people later, run this, changing the email and household name. People with the same household name share a list.
   ```sql
   insert into public.household_members (email, household) values ('someone@example.com', 'sister');
   ```
3. Send them the link. They tap **Create account** with that exact email.
4. Run `supabase-update-3-pantries.sql` once. It names each household's **pantry** (its recipe collection), shown on the left of the Recipes page. Each household can rename its own pantry in the app.

## How it works day to day

- **Add a recipe:** paste a link. The app reads the recipe that the site publishes for search engines, which most big recipe sites do. If a site doesn't publish one, open "Or paste the recipe text" and paste the recipe instead.
- **Prices:** the app has built-in **estimates** of H-E-B shelf prices for about 200 common items (`price-book.js`). Tap any price on the list to correct it. Your price is shared and used everywhere from then on. Items it doesn't recognize show **add price**; fill one in once and it's remembered.
- **Wrong item?** On a recipe, tap the word after **Buy:** to change what that ingredient counts as, for example "chicken thigh" instead of "chicken breast".
- **Shopping:** check items off in the store. Both phones update live, and checks you make with no signal save once you're back online.

## Costs

$0 at your usage. Supabase's free tier pauses a project after a week with no activity at all. If that happens, open supabase.com and click **Restore**; nothing is lost.
