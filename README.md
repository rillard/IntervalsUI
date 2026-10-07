# IntervalsUI training calendar

A small, dependency-free single page app for viewing planned Intervals.icu workouts in a month calendar.

## Run locally

From this folder, serve the files over localhost so browser requests to the Intervals.icu API have a normal web origin:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

The calendar starts with labeled sample workouts. Select **Connect Intervals.icu**, enter your personal API key from **Settings → Developer Settings**, and use athlete ID `0` for your own account. The app requests only `WORKOUT` calendar events for the displayed month. Your credentials are held in this browser tab's session storage and requests go directly from your browser to `https://intervals.icu/api/v1`.

This browser key flow is intended for a personal app. A public, multi-user version should use OAuth with a server-side authorization-code exchange so no OAuth client secret is shipped to the browser.

Detailed activity streams are cached in this browser's local storage for up to 24 hours (up to 8 activities) so reopening a session does not repeat the API request.
