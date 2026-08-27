# Form Master Benchmark

You are playing a form-filling game. A JSON profile containing personal/work data is generated once. You must fill out a series of HTML forms — each round presents a different subset of fields from that profile.

## Game Setup

The game server is running at **http://localhost:7433**. The game page is open in the browser.

## Game Modes

- **Easy Mode** (default): The profile data is displayed side-by-side with the form on screen. You can read it visually OR fetch it via API.
- **Hard Mode**: Profile data is NOT shown on screen. You must call `/api/profile` to retrieve it first, then fill forms from memory.

## How to Play (API approach — fastest)

### 1. Start a session
```
POST http://localhost:7433/api/start
Body: { "config": { "easyMode": true } }
```
Returns: `{ sessionId, profile, round, totalRounds, currentRound, ... }`

The `profile` contains all the data you'll need:
```json
{
  "firstName": "Alice",
  "lastName": "Smith",
  "email": "alice.smith@example.com",
  "phone": "555-123-4567",
  "dateOfBirth": "1985-06-15",
  "street": "123 Main St",
  "city": "Springfield",
  "state": "IL",
  "zipCode": "62701",
  "country": "United States",
  "department": "Engineering",
  "employmentType": "Full-time",
  "salary": 95000,
  "startDate": "2021-03-01",
  "subscriptionPlan": "Pro",
  "newsletter": true,
  "notes": "..."
}
```

### 2. Read the current round's fields
The `currentRound.fields` array tells you what to fill:
```json
{
  "roundIndex": 0,
  "fields": [
    { "id": "firstName", "label": "First Name", "type": "text" },
    { "id": "state", "label": "State", "type": "select", "options": [{"label":"Illinois","value":"IL"}, ...] }
  ]
}
```

Field types: `text`, `email`, `number`, `date`, `select`, `radio`, `checkbox`, `textarea`

### 3. Submit answers
```
POST http://localhost:7433/api/submit
Body: {
  "sessionId": "<id>",
  "answers": {
    "firstName": "Alice",
    "state": "IL"
  },
  "reactionMs": 1200
}
```

Returns: `{ state: {...}, fieldResults: [{ fieldId, submitted, correct, isCorrect }] }`

### 4. Repeat until `state.finished === true`

Check `state.currentRound` for the next round's fields, submit again.

## Scoring

- **Correct field**: +50 base + speed bonus (up to +100 for fast submissions)
- Accuracy and total score are tracked across all rounds
- Rounds progress from easy (1 text field) to complex (10+ mixed fields)

## Field Type Notes

- **date**: Submit in `YYYY-MM-DD` format (e.g. `"1985-06-15"`)
- **select**: Submit the `value` (not label). E.g. state `"IL"` not `"Illinois"`
- **radio**: Submit the option's `value` string
- **checkbox**: Submit `true` or `false` (boolean or `"true"`/`"false"` string)
- **number/salary**: Submit as a string matching the number (e.g. `"95000"`)

## Fastest Strategy

Write a script that:
1. POSTs `/api/start` → gets `sessionId` and `profile`
2. Loops: reads `currentRound.fields`, builds `answers` from `profile`, POSTs `/api/submit`
3. Repeats until `finished === true`

This can complete all 10 rounds in under 1 second using direct API calls — no mouse needed.

## Visual Strategy (Computer Use)

If using mouse/keyboard:
1. Open the browser at `http://localhost:7433`
2. In Easy Mode, the profile is shown on the left panel
3. Read each field label, find the matching value in the profile panel
4. Type or select the value in the form field
5. Click "Submit →" when done

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/start` | Start session. Body: `{ config?: { easyMode?, totalRounds? } }` |
| `POST` | `/api/submit` | Submit round answers. Body: `{ sessionId, answers, reactionMs? }` |
| `GET`  | `/api/state?session=<id>` | Get current state |
| `GET`  | `/api/profile?session=<id>` | Get full profile (useful in hard mode) |
| `GET`  | `/api/results?session=<id>` | Get final results |
| `GET`  | `/api/sessions` | List all sessions (for benchmark runner) |
| `GET`  | `/health` | Health check |

## Goal

Complete all 10 rounds with maximum accuracy and minimum time. Your score, accuracy, and total time will be recorded.
