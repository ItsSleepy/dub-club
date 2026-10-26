# Dub Club

A self-hosted party game for doing silly voices with friends, in the spirit of *Choicer Voicer*. One screen hosts, everyone else joins from their phone with a room code, records their take, and the room plays them back and votes.

Built so my friends and I could play it for free on our own server.

## Modes

- **Party:** the host picks a pack and the number of rounds. Each round shows a line and a direction ("as an overexcited theme park announcer"); players record on their phones, everyone listens back, then votes.
- **Dub:** a short video plays with its sound off and each player is given a role. Everyone records their lines in sync with the clip, then the dubbed scene plays back with all the voices.
- **Solo practice:** record and replay lines on your own, no room needed.
- **Manage:** create packs, add prompts, and upload or import clips (protected by an upload key).

Up to 12 players per room. If the host's browser drops, the room waits 15 minutes for them to come back.

## Packs

A pack is a folder in `packs/` with a `pack.json`:

```json
{
  "title": "Warm-up (no clips needed)",
  "prompts": [
    { "text": "\"I told you not to touch the red button.\"", "note": "as a deeply disappointed villain", "recordSeconds": 10 }
  ]
}
```

Prompts can also carry an image or audio clip. The importer (`importer.js`) converts existing *Choicer Voicer* pack zips: dub-mode packs (a video plus timestamped lines) become Dub packs, and everything else becomes a regular line pack. It needs `ffmpeg` and `unzip`.

Only the warm-up pack is included here; packs made from films or shows stay on my server.

## Run it

```bash
npm install
UPLOAD_KEY=choose-a-key node server.js     # http://localhost:3000
```

or with Docker (ffmpeg included):

```bash
docker build -t dub-club .
docker run -p 3000:3000 -e UPLOAD_KEY=choose-a-key -v $PWD/packs:/app/packs dub-club
```

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `PACKS_DIR` | `./packs` | where packs live |
| `UPLOAD_KEY` | empty | uploads and the Manage page are disabled until this is set |
| `INBOX_DIR` | `./inbox` | drop pack zips here to import them from the Manage page |

Microphone access needs HTTPS (or localhost). `deploy/` has the nginx site I use to put it behind a subdomain.

Built with Node, Express and Socket.IO; recordings use the browser's MediaRecorder.
