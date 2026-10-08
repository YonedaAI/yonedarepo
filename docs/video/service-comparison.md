# Presenter service comparison

Checked October 8, 2026 using authenticated Artlist and Higgsfield MCP tools. The final [8:48 script](presenter-script.md) and [scene manifest](presenter-scenes.json) are ready; the full presenter edit has rendered locally and remains private for owner review.

## Fair pilot

Both services received the same 39-word passage. The voice auditions use each service's own stock voice. The avatar comparison uses the original owner-supplied portrait and **the same measured 16.242-second Higgsfield narration file** on both services. This separates voice choice from avatar rendering. The pilot preserves the original portrait's clothing and background; the final production brief specifies a quiet office setting.

The portrait, generated likeness clips, account details and raw MCP responses remain in the ignored private production directory. They are not part of the public source. The initial stock-voice pilots did not use cloning; the owner's later custom voice is described below.

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

The owner initially selected **Artlist Sleek**, then rejected its delivery as robotic and unsuitable for the presenter after the styled office pilot. The owner supplied two recordings and requested narration in their own voice. The stock voices remain historical comparison inputs; further Sleek generation is on hold.

Both owner recordings have been cleaned locally. The combined reference is **44.74 seconds**, mono PCM at 48 kHz. The individual cleaned takes measure about -18 LUFS, with true peaks capped at -2 dBTP. Processing used a 65 Hz high-pass filter, a 12 kHz low-pass filter, light FFT noise reduction and two-pass loudness normalization. Individual speech timing was retained; only trailing silence was trimmed when combining the reference. A private browser preview provides original-versus-cleaned playback.

Artlist's authenticated voice-cloning catalog exposes MiniMax Voice Clone. Its initial cloning request returned **500 credits** and a mandatory voice-rights consent statement. The owner explicitly approved both, and creation completed. The resulting custom voice is available for narration through **MiniMax Speech 02 HD**. This approval is separate from the earlier avatar-generation gate. Two custom-voice narration auditions are ready. Take A requested speed 1.0 and measured **14.245 seconds**; Take B requested 0.9 and measured **14.269 seconds**. Both use the same 36-word passage, the same custom voice and no added voice effect. Each used **21 credits**. The requested speed difference did not produce a meaningful difference in total duration, so the second take is not described as slower. Browser playback was verified for both, and the owner selected **Take B**. All ten replacement narration takes completed and were downloaded, using **681 credits** in total. They measure **511.24 seconds**. The retimed 8:48 edit leaves **16.76 seconds** of chapter holds. Local Whisper small.en transcription recovered the complete script with token matches from 0.964 to 0.990; this checks copy, not perceived voice quality.

The owner also clarified that the final presenter should appear in a produced video scene. A second Higgsfield pilot completed in a 16:9 office setting with soft daylight, a desk, shelves and natural movement. It measures **13.05 seconds, 1920×1080, 24 fps**; sampled frames were inspected. Keep this visual setting when replacing the voice, then intercut real product footage. The square white-wall pilot is a likeness check. The replacement office clips completed at **15.05 and 20.05 seconds**, both 1920×1080 HEVC/AAC. The final 8:48 edit converts them to H.264 and uses the accepted owner narration throughout. The generated closing speech deviated after its opening passage, so only its first **4.8 seconds** are used; the edit returns to actual product footage for the rest. Sampled frames were inspected. Continuous lip-sync and listening acceptance remain owner review.

## What the evidence supports

The downloaded Higgsfield pilot is an H.264/AAC MP4, **17.056 seconds, 960×960 pixels, 24 fps**. Three sampled frames retain the portrait's glasses, beard, clothing and facial appearance, with changing mouth and head positions. This supports using it for a presenter pilot; sampled frames do not establish continuous identity stability or correct lip synchronization.

Higgsfield's tested stock-voice settings are closer to the script's target of 135 words/minute. This is a pacing result, not a judgment of pronunciation, tone or audio quality. The assistant cannot hear the generated audio. The owner accepted custom-voice Take B; local transcription checks and measured timing support assembly. Listening review of the final edit remains a separate acceptance step.

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

## Expressive revision

After reviewing the full Take B cut, the owner requested more passion and accepted an Optimistic opening audition. Revision 3 retains that exact audio and uses the same owner voice with MiniMax Speech 02 HD, speed 1.0, English and no effect throughout. Narration measures 476.89 seconds; the full export is 528.02 seconds with 93 caption cues and ten chapters. Both presenter windows were locally retimed to the final audio. Independent speech-envelope samples show maximum residuals of 30 ms at the opening and 40 ms at the closing. These measure timing; final perceived voice quality and continuous mouth accuracy remain owner playback judgments. No new subscription was purchased.
