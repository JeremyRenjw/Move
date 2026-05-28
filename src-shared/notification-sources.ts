export const NOTIFICATION_SOURCES = [
  {
    key: 'wechat',
    label: '微信',
    eventLabel: '微信有新消息',
    abbr: 'VX',
    short: 'vx',
    color: '#07c160',
    match: ['微信', 'wechat'],
  },
  {
    key: 'wework',
    label: '企业微信',
    eventLabel: '企微有新消息',
    abbr: 'QV',
    short: 'qv',
    color: '#4361ee',
    match: ['企业微信', 'wework'],
  },
  {
    key: 'claude',
    label: 'Claude',
    eventLabel: 'Claude',
    abbr: 'CC',
    short: 'cc',
    color: '#e8740c',
    match: ['claude'],
  },
  {
    key: 'codex',
    label: 'Codex',
    eventLabel: 'Codex',
    abbr: 'CX',
    short: 'cx',
    color: '#8b5cf6',
    match: ['codex'],
  },
] as const

export const FALLBACK_NOTIFICATION_SOURCE = {
  label: '通知',
  abbr: '!!',
  short: '!',
  color: '#64748b',
} as const

export type NotificationSourceKey = typeof NOTIFICATION_SOURCES[number]['key']

export const DEFAULT_NOTIFY_SOURCES: Record<NotificationSourceKey, boolean> = {
  wechat: true,
  wework: true,
  claude: true,
  codex: true,
}

export function getNotificationSource(key: string | undefined | null): typeof NOTIFICATION_SOURCES[number] | undefined {
  return NOTIFICATION_SOURCES.find(s => s.key === key)
}

export function getNotificationKeyByLabel(label: string): NotificationSourceKey | undefined {
  return NOTIFICATION_SOURCES.find(s => s.label === label)?.key
}

export function getNotificationLabelByKey(key: string): string | undefined {
  return getNotificationSource(key)?.label
}

export function getNotificationEventLabel(key: string): string | undefined {
  return getNotificationSource(key)?.eventLabel
}

export function normalizeNotificationSourceLabel(payload: { label?: string; source?: string }): string {
  const label = payload.label ?? ''
  const lower = label.toLowerCase()
  const fromLabel = NOTIFICATION_SOURCES.find(s => s.match.some(m => lower.includes(m.toLowerCase())))
  if (fromLabel) return fromLabel.label

  const raw = payload.source ?? ''
  const source = raw.startsWith('notify:') ? raw.slice(7) : raw
  const sourceLabel = getNotificationLabelByKey(source)
  return sourceLabel ?? (source || FALLBACK_NOTIFICATION_SOURCE.label)
}
