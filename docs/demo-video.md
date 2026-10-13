# Demonstration video production

The current October 13 reviewer walkthrough is a **6:00 captioned edit of actual current browser captures**. It shows the checked event-booking app, protected initial-build verification, GLM/Codex specialist captures, one coordinator repair under unchanged limits, readable context, multi-file changes and the optional graph. It has no narration and is explicitly labelled as an edited sequence, not a continuous live recording.

The last chapter separates this coordinated initial-build result from the controlled maintenance study. It does not claim a three-stage coordinated-team run, a causal graph benefit or canonical publication. The initial oracle passed four tests; three future-stage tests were skipped.

The current edit uses 12 chapters and 48 captions. Visual inspection found all captions legible. Full normal-speed native playback reached the end without seeking; ffmpeg decode passed. [Download the verified MP4](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-13/yonedarepo-reviewer.mp4). The passing playback excluded earlier half-speed and double-speed attempts. All captions were inspected using 30 rendered frames and 18 recorded player frames; that visual audit is distinct from playback proof. The older narrated videos below remain historical material.

```sh
python3 tools/render-reviewer-demo.py --captures PATH_TO_CURRENT_CAPTURES --output .local/reviewer-video
```

The renderer uses [the current scene manifest](reviewer-demo-scenes.json), checks the five-to-ten-minute duration, embeds captions and chapters, and needs Pillow plus ffmpeg/ffprobe only for optional video production. Reviewer credentials, raw transcripts and signed preview URLs are omitted from public captures.

## Historical presenter and narrated videos

For a presenter in the owner's likeness with a professional tech voice, use the new [8:48 presenter script](video/presenter-script.md), [scene manifest](video/presenter-scenes.json) and [Artlist/Higgsfield production brief](video/production-brief.md). A styled office presenter pilot and all ten owner-voice narration takes have been generated. The owner accepted the more expressive replacement voice. Revision 3 has rendered locally with synchronized presenter passages, embedded captions and ten chapters; decode, timing and browser checks passed. They remain private for owner review; short pilots are separate from the final video. See the production brief for offline assembly commands. The released video described below remains the historical walkthrough.

The release MP4 runs **8 minutes 48 seconds** (527.8 seconds) and is an edited walkthrough of actual served browser captures, recorded runtime concurrency, revision/check evidence and MCP continuation. Narration is synthetic (macOS Samantha). The video does not present still captures as a continuous live recording. The owner-directed selection provenance and unexercised personal BYOK inference are stated in the narration.

[Scene script](demo-scenes.json) is the narration source. [Release evidence](release-evidence.json) supplies the concurrency diagram and immutable revision identifiers. Screen captures include the deployed signup screen, real comparison/selection/history, published Garden site and an actual ready-for-review external follow-up. The brief composer is a local draft with an explicitly labelled placeholder provider; it starts no inference. Captured filter/RSVP transitions show real browser behavior, edited into the publication chapter.

Optional production requirements: macOS `say`, `ffmpeg`/`ffprobe`, Python 3.12+ and Pillow. They are not dependencies of the platform or local test gate.

```sh
python3 tools/render-demo.py --captures artifacts/screenshots --output artifacts/video
```

Output includes the H.264/AAC MP4, embedded chapters and subtitles, separate `.srt` captions and duration metadata. Caption timing is estimated from narration word positions; the scene script is the exact transcript. The renderer checks the final duration is between five and ten minutes. Input browser captures and interaction frames are available with the GitHub release; credentials and one-hour preview URLs are not included in public evidence.

The release publishes `yonedarepo-mvp.mp4`, `yonedarepo-mvp.srt`, `browser-captures.zip`, and `release-evidence.json`. The source export preserves implementation and public documentation while omitting raw private drafting conversations and private Git history. See `PUBLIC_SOURCE.md` in the exported repository for the originating implementation commit.
