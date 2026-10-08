# Presenter service comparison

Checked October 8, 2026 using authenticated Artlist and Higgsfield MCP tools. The final [8:48 script](presenter-script.md) and [scene manifest](presenter-scenes.json) are ready; the full presenter edit has not been rendered.

## Fair pilot

Both services received the same 39-word passage. The voice auditions use each service's own stock voice. The avatar comparison uses the original owner-supplied portrait and **the same measured 16.242-second Higgsfield narration file** on both services. This separates voice choice from avatar rendering. The pilot preserves the original portrait's clothing and background; the final production brief specifies a quiet office setting.

The portrait, generated likeness clips, account details and raw MCP responses remain in the ignored private production directory. They are not part of the public source. No voice was cloned.

| Check | Higgsfield | Artlist |
| --- | --- | --- |
| Voice audition | Seed Audio, Grady, speech rate -10 | Eleven v3, Sleek, default pacing |
| Measured audition duration | 16.242 seconds | 12.591 seconds |
| Measured pace | About 144 words/minute | About 186 words/minute |
| Avatar route | Seedance 2.5, image/audio references | Fabric 1.0, portrait/audio inputs |
| Avatar settings | 17 seconds, square, 720p | Premium, 720p, duration from shared audio |
| Avatar quote | 119 Higgsfield credits | 3,573 Artlist credits |
| Generation state | Completed and downloaded; sampled frames inspected | Stopped at the tool's explicit cost approval gate |

Credit units are service-specific. These quotes do not establish which service is cheaper in dollars. Artlist's separate fast model quoted more credits for this input, so a faster generation setting was not assumed to be a cheaper one.

## Owner selection and final visual direction

The owner auditioned both voices and selected **Artlist Sleek** for the final narration. This is the voice choice; the avatar service remains a separate decision. Reuse the Sleek audio in any presenter generation. The earlier shared Grady track remains the historical comparison input.

The owner also clarified that the final presenter should appear in a produced video scene. Use a 16:9 office setting with soft daylight, depth of field and natural movement, then intercut real product footage. The square white-wall pilot is a likeness check and is not the final visual direction. The full styled presenter edit has not been rendered. This voice selection does not approve Artlist's separate avatar-generation credit gate.

## What the evidence supports

The downloaded Higgsfield pilot is an H.264/AAC MP4, **17.056 seconds, 960×960 pixels, 24 fps**. Three sampled frames retain the portrait's glasses, beard, clothing and facial appearance, with changing mouth and head positions. This supports using it for a presenter pilot; sampled frames do not establish continuous identity stability or correct lip synchronization.

Higgsfield's tested voice settings are closer to the script's target of 135 words/minute. This is a pacing result, not a judgment of pronunciation, tone or audio quality. The assistant cannot hear the generated audio. The owner has now selected Sleek on listening preference; measure its final narration takes and check pacing before the full edit.

The comparison is not yet sufficient to name an avatar-quality winner. Inspect both completed clips for likeness, stable glasses and beard, mouth motion, natural head movement and synchronization to the shared audio. A model appearing in an authenticated catalog proves availability, not quality.

Use a brief presenter opening and closing, with real product captures throughout the walkthrough, as described in the [production brief](production-brief.md). This keeps product evidence readable and avoids spending on eight minutes of a talking head. Measure all final narration takes before setting reading holds and exporting exactly 08:48.

## Reproduce with connected tools

1. Connect `https://mcp.artlist.io/mcp` and `https://mcp.higgsfield.ai/mcp` through account OAuth. Discover the current models, voices and settings; these can change.
2. Generate the same short passage on each service and measure the resulting audio. Keep the voice model and rate explicit.
3. Upload the portrait privately. Reuse one completed audio take as the reference for both avatar tools.
4. Request actual quotes before generation. Honor any explicit credit approval gate. Do not resubmit a generation after an ambiguous timeout; first find its status.
5. Poll the returned generation ID, download the actual video, inspect it and record its measured duration and resolution.
6. Keep the raw account responses, media identifiers, signed URLs and likeness media outside Git. Publish only the approved final video.

The [Artlist MCP guide](https://help.artlist.io/hc/en-us/articles/38948588333469-Artlist-MCP-Connect-Claude-ChatGPT-and-VS-Code-to-Artlist) explains connection and generation. The [Higgsfield avatar workflow](https://higgsfield.ai/blog/talking-ai-avatar-inside-claude) describes combining identity references and speech. The authenticated model schemas and actual pilot outputs take precedence over general website descriptions.
