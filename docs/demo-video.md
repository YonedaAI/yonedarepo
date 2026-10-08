# Demonstration video production

For a presenter in the owner's likeness with a professional tech voice, use the new [8:48 presenter script](video/presenter-script.md), [scene manifest](video/presenter-scenes.json) and [Artlist/Higgsfield production brief](video/production-brief.md). That package is prepared copy and editing direction; no new avatar MP4 has been generated. The released video described below remains the historical walkthrough.

The release MP4 runs **8 minutes 48 seconds** (527.8 seconds) and is an edited walkthrough of actual served browser captures, recorded runtime concurrency, revision/check evidence and MCP continuation. Narration is synthetic (macOS Samantha). The video does not present still captures as a continuous live recording. The owner-directed selection provenance and unexercised personal BYOK inference are stated in the narration.

[Scene script](demo-scenes.json) is the narration source. [Release evidence](release-evidence.json) supplies the concurrency diagram and immutable revision identifiers. Screen captures include the deployed signup screen, real comparison/selection/history, published Garden site and an actual ready-for-review external follow-up. The brief composer is a local draft with an explicitly labelled placeholder provider; it starts no inference. Captured filter/RSVP transitions show real browser behavior, edited into the publication chapter.

Optional production requirements: macOS `say`, `ffmpeg`/`ffprobe`, Python 3.12+ and Pillow. They are not dependencies of the platform or local test gate.

```sh
python3 tools/render-demo.py --captures artifacts/screenshots --output artifacts/video
```

Output includes the H.264/AAC MP4, embedded chapters and subtitles, separate `.srt` captions and duration metadata. Caption timing is estimated from narration word positions; the scene script is the exact transcript. The renderer checks the final duration is between five and ten minutes. Input browser captures and interaction frames are available with the GitHub release; credentials and one-hour preview URLs are not included in public evidence.

The release publishes `yonedarepo-mvp.mp4`, `yonedarepo-mvp.srt`, `browser-captures.zip`, and `release-evidence.json`. The source export preserves implementation and public documentation while omitting raw private drafting conversations and private Git history. See `PUBLIC_SOURCE.md` in the exported repository for the originating implementation commit.
