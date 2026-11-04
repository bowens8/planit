# PlanIt

A calm daily planner: hourly Today view, your Google Calendar pulled in read-only, habits with streaks, study blocks, week and month views. Static site (GitHub Pages) + Firebase (Auth + Firestore). No build step.

## One-time setup (Firebase project `planit-356a2`)

1. **Authentication**: Firebase console → Build → Authentication → Get started → Sign-in method → enable **Google**.
2. **Firestore**: Build → Firestore Database → Create database (production mode). Then Rules tab, paste and publish:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
3. **Google Calendar API**: open https://console.cloud.google.com/apis/library/calendar-json.googleapis.com, make sure the project selector says `planit-356a2`, click **Enable**.
4. **OAuth consent screen** (Google Auth Platform in the same Cloud project): add the scope `.../auth/calendar.readonly` and add your Google account as a **Test user**. You'll see an "unverified app" warning on first sign-in; that's expected for a personal app. Click Advanced → Continue.
5. **Authorized domains**: Authentication → Settings → Authorized domains → add `YOUR-GITHUB-USERNAME.github.io`.

## Deploy to GitHub Pages

```
cd planit
git init && git add . && git commit -m "PlanIt"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/planit.git
git push -u origin main
```
Then repo Settings → Pages → Deploy from branch → `main` / root. Open the URL in Safari on your iPhone → Share → **Add to Home Screen**.

## Notes

- **Local preview:** add `?local` to the URL (e.g. `http://localhost:8123/index.html?local`) to run without Firebase; data stays in that browser.
- **Google reconnect:** the Calendar token lasts about an hour. If you open the app after a while you may see a "Reconnect" banner; one tap refreshes it. A Cloud Function with a refresh token (Blaze plan) can remove this later.
- **Sign-in on iPhone home-screen apps:** if the Google popup is blocked, PlanIt falls back to a redirect sign-in automatically.
- **Edits to repeating items** apply to the whole series. Use **Skip today** to pass on one day without breaking a streak.
- The stopwatch never logs on its own. **Add to today** saves the minutes to that day's log.
