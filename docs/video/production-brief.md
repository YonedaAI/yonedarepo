# Presenter video production brief

The deliverable is an edited **8:48 product walkthrough**, with a presenter in the owner's likeness, an engaged professional tech voice and actual YonedaRepo screen captures. The [final script](presenter-script.md), [plain narration](presenter-narration.txt) and [scene manifest](presenter-scenes.json) are ready for production. The full-length presenter edit has rendered locally: **528.02 seconds, 1920×1080, H.264/AAC, 30 fps**, with ten chapters and 93 caption cues. It remains private for owner listening and continuous lip-sync review; the historical release is unchanged. Short service-comparison samples are separate from the final edit. See the [measured service comparison](service-comparison.md) for pilot settings and current results.

## Creative direction

The owner confirmed that the final presenter should appear in a produced video scene. The square white-wall sample tested likeness only. Use the supplied portrait as the identity reference: preserve the rectangular dark glasses, short hair, beard and facial proportions. Generate a continuous 16:9 filmed scene in a quiet modern office, with warm wood, a softly blurred desk, soft daylight and natural shadows. Frame the presenter from the chest up in a navy crew-neck shirt, with room around the shoulders. Keep the expression relaxed, with natural blinks and small gestures. A founder explaining a working tool should sound interested and precise, with occasional pauses while the viewer reads the screen. Inspect a short sample in this final setting before rendering the full presenter passages.

Use **the owner's own voice**. After the styled pilot, the owner found the stock Sleek voice robotic and unsuitable for the presenter, and supplied two recordings. Both have been cleaned locally with light noise reduction, rumble filtering and two-pass volume normalization. A 44.74-second combined reference was used to create the custom voice after the owner approved Artlist's 500-credit charge and required consent statement. The owner initially selected Take B, then requested more passion after hearing the full cut. The owner accepted the replacement Optimistic opening. Revision 3 uses that exact opening audio and matching delivery for the remaining narration: 476.89 seconds of speech with 51.11 seconds of reading holds within 8:48. The presenter passages and full revised edit have rendered. Keep recordings, consent records and generated voice handles in the private production directory.

Revision 3 uses **MiniMax Speech 02 HD**, requested speed **1.0**, English, **Optimistic** emotion and no voice effect. The accepted opening audition is preserved; the remaining ten generation requests cover its continuation and scenes 02 through 10. Use the downloaded audio without time stretching. Measured duration determines the chapter holds, and video follows the final narration clock. Take B and Sleek are superseded production trials. Keep private voice handles and reference recordings out of the repository.

Use the presenter for the complete opening sentence, 6.7 seconds, and a 4.8-second return near the end. Both video windows are retimed to the accepted expressive narration. The generated closing take changed words after that point, so the edit cuts to real product footage while retaining the original owner narration. During the technical walkthrough, give the product the full frame and keep the same voice. This limits identity drift and lets the audience read the UI. If picture-in-picture is used, place it in a quiet corner away from controls, diffs and graph evidence.

Use 1920x1080, 30 fps, readable interface text and gentle cuts. Avoid animated cursor clicks on still screenshots. Use actual screen recordings for interaction, or present the still as a still with a subtle crop. Keep low-volume instrumental music optional; speech should remain clear. Show "AI presenter and voice; actual product captures; edited walkthrough" at the opening and in the description.

## Services and connection

**Artlist and Higgsfield are separate services.** The supplied `https://mcp.artlist.io/mcp` URL is Artlist's authenticated MCP server. After an initial unauthenticated HTTP 401, both Artlist and Higgsfield were connected through Codex's OAuth flow. Their actual MCP catalogs, voice libraries and model settings were inspected. Private account balances, tokens, reference media and generation responses stay outside the public repository. The production session later disabled the local MCP connections and its Keychain helper after repeated macOS credential prompts. Remaining presenter work uses the signed-in website. Do not restart that helper or read Keychain during assembly.

For Artlist, add that URL as a custom MCP connector in the host you use and complete Artlist sign-in. Its [official MCP guide](https://help.artlist.io/hc/en-us/articles/38948588333469-Artlist-MCP-Connect-Claude-ChatGPT-and-VS-Code-to-Artlist) documents voice/model discovery and media generation. Ask the connected tools for available voices and model input schemas before constructing generation calls. The [avatar guide](https://artlist.io/ai/avatars) describes image-and-audio presenter generation in the Toolkit; the MCP model inventory must confirm whether the needed avatar operation is exposed to your account. Use the Toolkit if it is not.

For Higgsfield MCP, use `https://mcp.higgsfield.ai/mcp` and complete account authorization. The inspected catalog exposes `seedance_2_5` with image/audio references and 4 to 30 second clips, plus reusable preset voices. This MCP connection uses the existing account rather than a developer API key. The [official avatar workflow](https://higgsfield.ai/blog/talking-ai-avatar-inside-claude) describes identity, reusable voice and speech-driven video. A single portrait can serve as a direct reference; it is not a trained multi-photo Soul identity.

For the separate Higgsfield developer API, the [official API quick start](https://open.higgsfield.ai/quick-start) documents `https://api.higgsfield.ai`, complete API keys under the `Key` authorization scheme, signed reference uploads and asynchronous request status. Follow its linked model catalog and input schema for the chosen operation. [Talking Avatar](https://higgsfield.ai/ai-talking-avatar) documents the browser workflow, but that does not prove the same avatar model is available through the API. Do not substitute the Artlist MCP URL for a Higgsfield API endpoint or invent an avatar request body.

These service notes were checked October 8, 2026. The authenticated Artlist catalog includes Fabric 1.0, HeyGen Avatar 4, OmniHuman 1.5 and Seedance 2.5. Fabric settings require both a portrait and audio, with 480p/720p output. Current generation quotes and actual pilot results determine which route to use; a catalog entry alone does not establish output quality. Both services quote in different credit units, so raw credit counts are not dollar comparisons.

## Generation order

1. Keep the owner's portrait in a private production folder outside the public repository. Upload it only to the selected avatar service. Credentials belong in the connector or server environment, never the scene manifest or screenshots.
2. The custom voice was created after explicit cost and voice-rights approval. The owner accepted the expressive replacement opening, and matching full narration is downloaded. Retain the office setting from the styled pilot and use the new matching audio for presenter clips. Reuse the accepted voice and supported settings for every scene.
3. Use the ten downloaded narration takes corresponding to `narration` in the manifest. Treat `visuals`, `assets`, `on_screen` and presenter directions as editing instructions, not spoken text.
4. Measure the audio. Each take must fit its scene with room for a short reading hold. Adjust delivery or re-record a take that overruns; avoid stretching speech to force a duration. The revised owner-voice narration measures 476.89 seconds. The manifest leaves 51.11 seconds across the chapter holds.
5. Generate lip-synced presenter clips for the marked `presenter_windows_seconds`, using the matching measured audio passage. Split further if the chosen model's schema requires shorter clips. Maintain the same portrait, wardrobe, framing and voice.
6. Assemble real product captures under the remaining narration. Use the exact scene boundaries in the manifest and hold the final source/try-it links through **08:48**. The old release video is evidence footage, not a finished version of this new presenter edit.
7. Export H.264/AAC MP4 and captions timed to the measured audio. Inspect the full result for pronunciation, lip sync, readable text, hidden credentials and correct source revision labels. Verify the final duration with `ffprobe`.

## Copy-ready prompt for the connected production agent

```text
Prepare the YonedaRepo presenter video using presenter-scenes.json as the edit
manifest and presenter-narration.txt as the spoken copy. Target exactly 08:48.
Use the supplied owner's portrait as the likeness reference. Preserve identity,
glasses and beard. Use the owner's custom voice for all narration, including
lip-synced presenter passages. Honor the service's cost and consent gate before
creating the voice. Check a short passage with the owner before generating the
full narration. Preserve natural delivery and measure actual takes.
Generate a 16:9 filmed office scene with soft daylight, natural shadows and a
subtle blurred background. Keep the portrait as an identity reference. The square
white-wall likeness pilot is not final footage. Check a short sample in the final
setting before rendering the presenter passages.
Use real product captures for all UI, source, graph and published-site footage.
Never generate or redraw the product UI. Opening and closing presenter windows
are marked in the manifest; the rest is narration over product footage.

First discover the connected account's voices, models, input schemas, duration
limits and credit estimates. Report any missing avatar/audio operation. Do not
claim a model is available from a website description alone. Produce a short
sample before preparing the full set of takes. Keep credentials and the portrait
out of the public source repository. Caption synthetic presenter/voice and edited
actual captures. Preserve all statements about recorded evidence and limitations.
```

## Capture inventory and evidence

`release:browser-captures/...` entries refer to the curated capture archive on the [existing MVP release](https://github.com/MagnetonIO/yonedarepo/releases/tag/mvp-2026-10-08). Extract it and resolve the filename from the archive. Current UI images live in `docs/images`. Markdown/JSON assets in the manifest are sources for an editor-rendered diagram or a fresh screen capture, not video files. No expiring preview capability URL should appear in the export.

The new UI captures and the older Garden evidence belong to different views and times. Keep the chapter labels clear. The Garden choice was owner-directed in chat and entered through the website by the implementer. Field Notes' first publication was automated development verification; its checked follow-up remains unpublished. Do not animate a new selection or inference run that did not happen.

The script keeps current limits visible: static hosting, no automatic semantic merge, no clarification pause/resume, and no paid Gemini acceptance. Five configured providers does not mean five demonstrated successful hosted runs. [Release evidence](../release-evidence.md) and [current workflow verification](../ui-workflow-evidence.md) support the product claims.

## Offline assembly

The optional Python helpers assemble already-generated media. They do not call a
provider, upload files, read credentials or start agent runs. Run from the repository
root with Python 3.12+, `ffmpeg`/`ffprobe`, Pillow and Arial or DejaVu Sans installed.
Whisper is needed only for the local alignment step; its first use downloads the
public model weights. Keep the production directory ignored and private.

```sh
python3 -m venv .local/video-venv
.local/video-venv/bin/pip install Pillow==11.2.1 openai-whisper==20250625
```

Supply these files under a private production directory:

- `narration/scene-01.mp3` through `scene-10.mp3`: the accepted voice takes.
- `presenter/opening-synced.mp4`: 6.7 seconds, retimed to scene 01's accepted narration.
- `presenter/closing-synced.mp4`: 4.8 seconds, matching scene 10's first 4.8 seconds.
- `alignment/scene-01.json` through `scene-10.json`: created by the alignment command.

Extract the curated release screenshots into `artifacts/screenshots`, and its
interaction frames into `artifacts/video/interaction`. The renderer also uses
current captures in `docs/images`; [presenter-edit.json](presenter-edit.json) lists
every visual and its duration.

```sh
.local/video-venv/bin/python tools/align-presenter.py \
  --production .local/media/production-expressive --model small.en
.local/video-venv/bin/python tools/render-presenter.py \
  --production .local/media/production-expressive --output .local/media/final-expressive
```

Alignment stays on the local machine. It records the audio hash and model name,
reuses matching results, and writes transcript differences for inspection. Assembly
rejects stale alignment, substantial copy differences, missing captures, short
presenter clips and narration that leaves less than one second per chapter. It
requires the manifest's accepted-voice flag and checks the total duration is 528
seconds. It produces an H.264/AAC MP4 with chapters and embedded captions, separate
SRT/WebVTT captions and measurement metadata. Listening, continuous lip-sync review and final
readability remain human acceptance checks.

The initial generated opening changed the supplied speech's pacing. Revision 3 maps its complete first sentence through 19 measured boundaries onto the accepted expressive audio; the closing uses 14 boundaries. Independent speech-envelope comparisons found maximum residuals of 30 ms across six sampled opening windows and 40 ms across four closing windows. This measures timing, not continuous mouth accuracy. Sampled mouth frames were also inspected. The final MP4 passed full decode, duration, chapter, caption and waveform checks; browser playback and chapter seeking were verified with autoplay and looping disabled. The result remains private for owner playback acceptance.

For a generated clip that already matches its own audio, the optional local
retiming command is:

```sh
python3 tools/sync-presenter.py \
  --source .local/media/production-expressive/presenter/opening-source.mp4 \
  --reference .local/media/production-expressive/narration/scene-01.mp3 \
  --speech-check .local/media/production-expressive/presenter/speech-check.json \
  --section opening --seconds 6.7 \
  --output .local/media/production-expressive/presenter/opening-synced.mp4
```

The speech-check JSON contains local Whisper `reference_segments` and
`generated_segments` under `opening`; each segment includes word start/end
timestamps. Trim the source to the intended complete phrase first. Inspect and annotate inconsistent proper-name ASR tokenization before retiming. Keep it private with the audio. The command rejects substantial
transcript differences and implausible timing changes, and records input hashes
and the time map. It corrects timing drift; it does not generate new mouth shapes.

## Humanizer editing pass

The [working draft](presenter-draft.md) adapts the released narration. The draft still sounded like a checklist: it stacked platform details, repeated evidence disclaimers and announced each topic before explaining it. Its closing counted tests instead of giving the viewer a clear product outcome. It also described the older interface and four-provider setup.

The final rewrite starts with the builder's reason for the product, uses the filter defect as a concrete example, and explains verification where the viewer can see it. The owner decision and unpublished follow-up remain explicit. Current navigation, named connections, four hosted approaches and Gemini are reflected without claiming a paid Gemini result. The spoken copy contains no em or en dashes and avoids sales language. Stage directions stay outside the narration.
