# 💬 Talk with Adi

A real-time **one-to-many broadcast chat** app. One admin (**Adi**) chats privately
with many visitors. Visitors can never see or message each other — only the admin.

Built with **Node.js + Express + Socket.io**, plain HTML/CSS/JS on the frontend,
and **WebRTC** (with a Google STUN server) for video calls.

## Features

- ✅ Public visitor page — enter a name and start chatting with Adi
- ✅ Password-protected admin dashboard with a live sidebar of every visitor
  (online/offline dot, unread badges, last-message preview)
- ✅ Real-time private chat (Socket.io rooms: each visitor is isolated)
- ✅ Image sharing in both directions — small images sent inline as **base64**,
  larger ones uploaded to the server (`/uploads`)
- ✅ Two-way video calling (WebRTC): admin can call any visitor, visitors can call
  the admin. Uses the browser's **normal camera/mic permission prompt** — nothing
  hidden or automatic. Calls even show an accept/decline ring screen.
- ✅ Typing indicators, online presence, reconnect/session resume (localStorage)

## File structure

```
talk-with-adi/
├── server.js        ← Express + Socket.io server (ADMIN_PASSWORD lives here)
├── package.json
└── public/
    ├── index.html   ← visitor chat page
    ├── admin.html   ← admin dashboard (password protected)
    ├── style.css    ← shared styles
    ├── client.js    ← visitor logic + WebRTC
    └── admin.js     ← admin logic + WebRTC
```

## Run it locally

```bash
cd talk-with-adi
npm install
npm start
```

Then open:

| Page          | URL                            |
| ------------- | ------------------------------ |
| Visitor chat  | http://localhost:3000/         |
| Admin panel   | http://localhost:3000/admin.html |

**Admin password:** `adi123` — change the `ADMIN_PASSWORD` constant at the top of
`server.js` (or set an `ADMIN_PASSWORD` environment variable, which takes priority).

> 💡 Video calls need a **secure context**: `localhost` works out of the box;
> when deployed, use HTTPS (Render provides it automatically). For the best
> experience, test the two sides in two different browsers or one normal + one
> incognito window.

## Deploy on Render.com ✅

The server listens on `process.env.PORT`, so it's Render-ready out of the box:

1. Push this repo to GitHub.
2. In Render → **New → Web Service**, pick the repo and set:
   - **Root Directory:** `talk-with-adi`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
3. (Recommended) Add an environment variable `ADMIN_PASSWORD` with your own password
   so it isn't hardcoded.
4. Deploy — Render gives you an HTTPS URL. Visitors use `/`, you use `/admin.html`.

## Notes

- Chat history is kept **in memory** and resets when the server restarts.
- Uploaded images are stored in `./uploads` (Render's disk is ephemeral — they
  survive restarts only while the instance lives).
- STUN server used: `stun:stun.l.google.com:19302`. If you later need calls across
  very restrictive networks, add a TURN server to the `iceServers` lists in
  `client.js` and `admin.js`.
