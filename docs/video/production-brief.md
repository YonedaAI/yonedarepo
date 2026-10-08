# Presenter video production brief

The deliverable is an edited **8:48 product walkthrough**, with a presenter in the owner's likeness, a calm professional tech voice and actual YonedaRepo screen captures. The [final script](presenter-script.md), [plain narration](presenter-narration.txt) and [scene manifest](presenter-scenes.json) are ready for production. The full-length presenter video has not been rendered. Short service-comparison samples are separate from the final edit. See the [measured service comparison](service-comparison.md) for pilot settings and current results.

## Creative direction

Use the supplied portrait as the identity reference: preserve the rectangular dark glasses, short hair, beard and facial proportions. Frame the presenter from the chest up in a navy crew-neck shirt, with soft daylight and a quiet office background. Keep the expression relaxed and gestures small. A founder explaining a working tool should sound interested and precise, with occasional pauses while the viewer reads the screen.

Choose an adult male stock voice in neutral American English, warm mid-low register, at about **135 words per minute**. The photo provides a likeness reference, not a voice reference. A cloned voice would require a separate recording; this package specifies a stock voice. Pronounce YonedaRepo as "yoh-NEH-dah REE-poh" and read MCP as letters. Do not speak source hashes aloud.

Use the presenter for about 15 seconds at the opening and 20 seconds near the end. During the technical walkthrough, give the product the full frame and keep the same voice. This limits identity drift and lets the audience read the UI. If picture-in-picture is used, place it in a quiet corner away from controls, diffs and graph evidence.

Use 1920x1080, 30 fps, readable interface text and gentle cuts. Avoid animated cursor clicks on still screenshots. Use actual screen recordings for interaction, or present the still as a still with a subtle crop. Keep low-volume instrumental music optional; speech should remain clear. Show "AI presenter and voice; actual product captures; edited walkthrough" at the opening and in the description.

## Services and connection

**Artlist and Higgsfield are separate services.** The supplied `https://mcp.artlist.io/mcp` URL is Artlist's authenticated MCP server. After an initial unauthenticated HTTP 401, both Artlist and Higgsfield were connected through Codex's OAuth flow. Their actual MCP catalogs, voice libraries and model settings were inspected. Private account balances, tokens, reference media and generation responses stay outside the public repository.

For Artlist, add that URL as a custom MCP connector in the host you use and complete Artlist sign-in. Its [official MCP guide](https://help.artlist.io/hc/en-us/articles/38948588333469-Artlist-MCP-Connect-Claude-ChatGPT-and-VS-Code-to-Artlist) documents voice/model discovery and media generation. Ask the connected tools for available voices and model input schemas before constructing generation calls. The [avatar guide](https://artlist.io/ai/avatars) describes image-and-audio presenter generation in the Toolkit; the MCP model inventory must confirm whether the needed avatar operation is exposed to your account. Use the Toolkit if it is not.

For Higgsfield MCP, use `https://mcp.higgsfield.ai/mcp` and complete account authorization. The inspected catalog exposes `seedance_2_5` with image/audio references and 4 to 30 second clips, plus reusable preset voices. This MCP connection uses the existing account rather than a developer API key. The [official avatar workflow](https://higgsfield.ai/blog/talking-ai-avatar-inside-claude) describes identity, reusable voice and speech-driven video. A single portrait can serve as a direct reference; it is not a trained multi-photo Soul identity.

For the separate Higgsfield developer API, the [official API quick start](https://open.higgsfield.ai/quick-start) documents `https://api.higgsfield.ai`, complete API keys under the `Key` authorization scheme, signed reference uploads and asynchronous request status. Follow its linked model catalog and input schema for the chosen operation. [Talking Avatar](https://higgsfield.ai/ai-talking-avatar) documents the browser workflow, but that does not prove the same avatar model is available through the API. Do not substitute the Artlist MCP URL for a Higgsfield API endpoint or invent an avatar request body.

These service notes were checked October 8, 2026. The authenticated Artlist catalog includes Fabric 1.0, HeyGen Avatar 4, OmniHuman 1.5 and Seedance 2.5. Fabric settings require both a portrait and audio, with 480p/720p output. Current generation quotes and actual pilot results determine which route to use; a catalog entry alone does not establish output quality. Both services quote in different credit units, so raw credit counts are not dollar comparisons.

## Generation order

1. Keep the owner's portrait in a private production folder outside the public repository. Upload it only to the selected avatar service. Credentials belong in the connector or server environment, never the scene manifest or screenshots.
2. Generate one short voice sample using the opening paragraph. Check pronunciation and pacing. Reuse that voice ID and settings for every scene.
3. Generate ten narration takes from `narration` in the manifest. Treat `visuals`, `assets`, `on_screen` and presenter directions as editing instructions, not spoken text.
4. Measure the audio. Each take must fit its scene with room for a short reading hold. Adjust delivery or re-record a take that overruns; avoid stretching speech to force a duration. The 1,066 spoken words leave about 54 seconds for screen reading at 135 wpm. The actual voice result determines the holds.
5. Generate lip-synced presenter clips for the marked `presenter_windows_seconds`, using the matching measured audio passage. Split further if the chosen model's schema requires shorter clips. Maintain the same portrait, wardrobe, framing and voice.
6. Assemble real product captures under the remaining narration. Use the exact scene boundaries in the manifest and hold the final source/try-it links through **08:48**. The old release video is evidence footage, not a finished version of this new presenter edit.
7. Export H.264/AAC MP4 and captions timed to the measured audio. Inspect the full result for pronunciation, lip sync, readable text, hidden credentials and correct source revision labels. Verify the final duration with `ffprobe`.

## Copy-ready prompt for the connected production agent

```text
Prepare the YonedaRepo presenter video using presenter-scenes.json as the edit
manifest and presenter-narration.txt as the spoken copy. Target exactly 08:48.
Use the supplied owner's portrait as the likeness reference. Preserve identity,
glasses and beard. Cast a calm professional male technical voice at about 135 wpm.
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

## Humanizer editing pass

The [working draft](presenter-draft.md) adapts the released narration. The draft still sounded like a checklist: it stacked platform details, repeated evidence disclaimers and announced each topic before explaining it. Its closing counted tests instead of giving the viewer a clear product outcome. It also described the older interface and four-provider setup.

The final rewrite starts with the builder's reason for the product, uses the filter defect as a concrete example, and explains verification where the viewer can see it. The owner decision and unpublished follow-up remain explicit. Current navigation, named connections, four hosted approaches and Gemini are reflected without claiming a paid Gemini result. The spoken copy contains no em or en dashes and avoids sales language. Stage directions stay outside the narration.
