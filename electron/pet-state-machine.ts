import type { EventKind, PetDisplayState } from '../src-shared/types'

/**
 * Deterministic state machine mapping (EventKind, current) → next PetDisplayState.
 * Inspired by Hopet's SessionStateMachine. Pure function — no side effects, easy to test.
 * Returns null when the event should be ignored for the given current state.
 */
export function nextState(current: PetDisplayState, event: EventKind): PetDisplayState | null {
  switch (event) {
    case 'session_start':
      return 'idle'

    case 'session_end':
      return null

    // User sends a new prompt → agent starts responding
    case 'user_prompt':
      return 'responding'

    // Agent enters thinking phase (only from responding)
    case 'thinking_start':
      return current === 'responding' ? 'thinking' : null

    // Tool execution begins (from responding, thinking, or idle cold-start)
    case 'pre_tool_use':
      if (current === 'responding' || current === 'thinking' || current === 'idle') return 'tool_use'
      return null

    // Tool execution completes → back to responding
    case 'post_tool_use':
      if (current === 'tool_use' || current === 'permission_prompt') return 'responding'
      return null

    // Agent asks for permission to use a tool
    case 'permission_ask':
      if (current === 'responding' || current === 'thinking' || current === 'tool_use' || current === 'idle')
        return 'permission_prompt'
      return null

    // Permission granted/denied → back to responding
    case 'permission_resolved':
      if (current === 'permission_prompt') return 'responding'
      return null

    // Agent asks user a question (AskUserQuestion)
    case 'ask_user':
      if (current === 'responding' || current === 'thinking' || current === 'tool_use' || current === 'idle')
        return 'ask_user'
      return null

    // User answered the question → back to responding
    case 'ask_user_resolved':
      if (current === 'ask_user') return 'responding'
      return null

    // Agent finished its turn
    case 'stop':
      if (current === 'idle' || current === 'completed' || current === 'error') return null
      return 'completed'

    // Tool failure / fatal error
    case 'error':
      if (current === 'idle' || current === 'completed' || current === 'error') return null
      return 'error'

    // External notification (wechat, etc.) — no state change
    case 'notification':
      return null
  }
}

const STATE_LABELS: Record<PetDisplayState, string> = {
  idle:              '空闲',
  thinking:          '思考中',
  responding:        '回复中',
  tool_use:          '使用工具',
  permission_prompt: '等待授权',
  ask_user:          '等待回答',
  completed:         '已完成',
  error:             '出错了',
}

export function stateLabel(state: PetDisplayState): string {
  return STATE_LABELS[state]
}
