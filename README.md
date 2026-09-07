# pongetti.net

A minimal, Twitter-style feed of links, hosted on GitHub Pages. Everything lives in this repo.

- `index.html` — the feed (infinite scroll, subtle animations, dark/light, client-side filter).
- `post.html` — the posting form (`/post`). Calls the GitHub API from the browser using a fine-grained token stored in your phone's browser. The token is the only thing that can write here, so only you can post.
- `manifest.json` — makes the site installable via *Add to Home screen* and registers it as an Android **Share target**, so any app's Share menu can send a link to `/post`.
- `posts/*.json` — source of truth, one file per post: `{ id, url, note, created, meta }`.
- `feed/` and `feed.xml` — **generated** by `scripts/build-feed.mjs`; do not edit by hand.
- `.github/workflows/build.yml` — on every push to `posts/`, fetches link metadata (title, description, image) once per post, paginates into `feed/page-N.json`, writes RSS, commits back. Pages then redeploys from `main`.
- `.github/workflows/issue-to-post.yml` — fallback: open an issue containing a link and it becomes a post (owner only).

## Posting from your phone

1. GitHub → Settings → Developer settings → Fine-grained tokens → new token. Repository access: only this repo. Permission: **Contents: read & write**. Set an expiry.
2. Open `https://www.pongetti.net/post`, paste the token (optionally set a passphrase), save.
3. In Chrome: ⋮ → *Add to Home screen*. From then on, share any link → **pongetti.net** → add a note → Post.

## Local build

```
node scripts/build-feed.mjs     # Node 20+, no dependencies
python3 -m http.server 8000     # then open http://localhost:8000
```
