#!/usr/bin/env bash
set -u

LOG_FILE="${TMPDIR:-/tmp}/knowhow-voice-continuous-$PPID.log"
CLI="${KNOWHOW_CLI:-knowhow}"

cat <<'TEXT'

VOICE ENDPOINTING TEST
======================
When "[voice] listening" appears, read this paragraph in one continuous turn.
Speak naturally through commas, but do not intentionally pause for a full second.
After the paragraph, remain silent until a single "heard:" line appears, then press Ctrl-C.

  This is a continuous reading test for the Knowhow voice control system. I am
  reading one complete paragraph at a steady and comfortable pace, with short natural
  pauses at commas, so the recorder should keep listening until I reach the final
  sentence. The quick brown fox jumps over the lazy dog, my tmux prefix is Control A,
  and Spotify is ready to play the Drive soundtrack. This is the end of the paragraph.

Expected: exactly one "heard:" entry containing the whole paragraph.
If several entries appear before you finish, silence endpointing fired too early.

TEXT

finish() {
  printf '\n--- endpointing report ---\n'
  local count
  # Whisper can emit a second noise-only result when the user reaches for Ctrl-C.
  # Do not mistake that for an endpoint split in the spoken paragraph.
  count=$(awk '/^heard:/ {
    text = $0
    sub(/^heard:[[:space:]]*/, "", text)
    gsub(/\[BLANK_AUDIO\]/, "", text)
    gsub(/\((keyboard clicking|silence|background noise)\)/, "", text)
    gsub(/[[:space:]]/, "", text)
    if (length(text) > 0) count++
  } END { print count + 0 }' "$LOG_FILE" 2>/dev/null)
  printf 'Completed transcription chunks: %s\n' "$count"
  if [[ "$count" == "1" ]]; then
    echo 'PASS: the continuous reading was kept as one utterance.'
  elif [[ "$count" == "0" ]]; then
    echo 'INCONCLUSIVE: no completed transcription was captured.'
  else
    echo 'FAIL: the reading was split into multiple utterances.'
  fi
  echo "Log: $LOG_FILE"
}
trap finish EXIT

# No wake phrase is required: every STT result is printed as "heard:" even while the
# agent remains asleep. Keep the reading below the normal 30-second safety boundary.
VAD_THRESHOLD="${VAD_THRESHOLD:-0.012}"
VAD_SILENCE_MS="${VAD_SILENCE_MS:-1000}"
printf 'Settings: vad-threshold=%s vad-silence-ms=%s\n' "$VAD_THRESHOLD" "$VAD_SILENCE_MS"
"$CLI" voice-control \
  --vad-threshold "$VAD_THRESHOLD" \
  --vad-silence-ms "$VAD_SILENCE_MS" \
  2>&1 | tee "$LOG_FILE"
