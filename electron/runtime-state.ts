import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const WRAPPER_BODY = `#!/bin/sh
# mote-managed (do not edit manually; rewritten by Mote on startup)
# Reads hook JSON payload from stdin, extracts whitelisted fields, writes enriched event file.
DIR="$HOME/.mote/events"
mkdir -p "$DIR"

EVENT="$1"
TOOL="$2"
[ -n "$EVENT" ] && [ -n "$TOOL" ] || exit 0

CWD=$(pwd)
TS=$(date +%s)

# Read stdin (hook payload JSON) and extract whitelisted fields via python3
STDIN=$(cat 2>/dev/null)
ENRICHED=$(python3 -c "
import json, sys
raw = '''$STDIN'''
try:
    d = json.loads(raw) if raw.strip() else {}
except:
    d = {}
ALLOWED = ['session_id','prompt','tool_name','tool_input','cwd','notification_type','message','parent_session_id','agent_id','subagent_id','transcript_path']
payload = {}
for k in ALLOWED:
    if k in d and d[k]:
        v = d[k]
        if isinstance(v, str) and len(v) > 256:
            v = v[:256]
        payload[k] = v
# tool_input can be large; only keep safe sub-keys
ti = payload.get('tool_input')
if isinstance(ti, dict):
    safe_ti = {}
    for sk in ['command','file_path','question']:
        if sk in ti:
            safe_ti[sk] = ti[sk]
    payload['tool_input'] = safe_ti if safe_ti else None
payload = {k:v for k,v in payload.items() if v is not None}
print(json.dumps(payload, ensure_ascii=False, separators=(',',':')))
" 2>/dev/null || echo "{}")

# Map hook event names to EventKind
case "$EVENT" in
  SessionStart)       KIND="session_start" ;;
  Stop)               KIND="stop" ;;
  Notification)       KIND="notification" ;;
  PermissionRequest)  KIND="permission_ask" ;;
  UserPromptSubmit)   KIND="user_prompt" ;;
  PreToolUse)         KIND="pre_tool_use" ;;
  PostToolUse)        KIND="post_tool_use" ;;
  *)                  KIND="$EVENT" ;;
esac

FILE="$DIR/\${TS}-\$$-$RANDOM.json"

# Build the enriched JSON envelope
python3 -c "
import json, sys
ev = '''$KIND'''
tool = '''$TOOL'''
cwd = '''$CWD'''
ts = $TS
payload = json.loads('''$ENRICHED''')
sid = payload.pop('session_id', None)
out = {'event': ev, 'tool': tool, 'cwd': cwd, 'ts': ts}
if sid: out['sessionId'] = sid
if payload: out['payload'] = payload
print(json.dumps(out, ensure_ascii=False))
" > "$FILE" 2>/dev/null || echo "{\\"event\\":\\"$KIND\\",\\"tool\\":\\"$TOOL\\",\\"cwd\\":\\"$CWD\\",\\"ts\\":$TS}" > "$FILE"
`

export class RuntimeState {
  private dir:     string
  private binDir:  string
  private wrapper: string
  eventsDir: string

  constructor(home: string = os.homedir()) {
    this.dir      = path.join(home, '.mote')
    this.binDir   = path.join(this.dir, 'bin')
    this.wrapper  = path.join(this.binDir, 'event')
    this.eventsDir = path.join(this.dir, 'events')
  }

  get wrapperPath(): string { return this.wrapper }

  ensureWrapper(): void {
    fs.mkdirSync(this.binDir, { recursive: true, mode: 0o755 })
    let needsWrite = true
    try {
      const existing = fs.readFileSync(this.wrapper, 'utf-8')
      if (existing === WRAPPER_BODY) needsWrite = false
    } catch { /* missing -- write */ }
    if (needsWrite) {
      fs.writeFileSync(this.wrapper, WRAPPER_BODY, { mode: 0o755 })
      fs.chmodSync(this.wrapper, 0o755)
    }
  }
}
