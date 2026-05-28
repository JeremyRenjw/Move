import { useCallback, useEffect, useState } from 'react'
import { IPC } from '@shared/types'
import type { AgentTask, AgentTaskCreateInput, AgentTaskRun } from '@shared/types'

const ipc = window.ipc

function formatTime(ts?: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusLabel(task: AgentTask): string {
  if (!task.approved) return '待审批'
  if (!task.enabled) return '已停用'
  if (task.lastStatus === 'running') return '运行中'
  if (task.schedule === 'manual') return '手动'
  return '自动'
}

export function AgentTab() {
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [runs, setRuns] = useState<AgentTaskRun[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [manualOnly, setManualOnly] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [nextTasks, nextRuns] = await Promise.all([
        ipc.invoke(IPC.AGENT_TASKS_LIST) as Promise<AgentTask[]>,
        ipc.invoke(IPC.AGENT_TASK_RUNS) as Promise<AgentTaskRun[]>,
      ])
      setTasks(nextTasks)
      setRuns(nextRuns)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
    return ipc.on(IPC.AGENT_TASK_RAN, () => reload())
  }, [reload])

  const createTask = async () => {
    const input: AgentTaskCreateInput = {
      title,
      goal,
      schedule: manualOnly ? 'manual' : 'interval',
      intervalMinutes: manualOnly ? undefined : intervalMinutes,
      enabled: true,
      approved: true,
      requireApproval: true,
      source: 'user',
    }
    await ipc.invoke(IPC.AGENT_TASKS_CREATE, input)
    setTitle('')
    setGoal('')
    setCreating(false)
    await reload()
  }

  if (loading) return <div style={styles.loading}>加载中...</div>

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.heading}>Agent 任务</h2>
          <p style={styles.subtle}>让 Mote 在后台定时观察、总结和提醒。AI 创建的任务需要先审批。</p>
        </div>
        <button style={styles.primaryBtn} onClick={() => setCreating(v => !v)}>
          {creating ? '取消' : '新建任务'}
        </button>
      </div>

      {creating && (
        <div style={styles.form}>
          <input style={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder="任务标题" />
          <textarea style={styles.textarea} value={goal} onChange={e => setGoal(e.target.value)} placeholder="每次运行要观察、分析或提醒什么" />
          <div style={styles.row}>
            <label style={styles.checkLabel}>
              <input type="checkbox" checked={manualOnly} onChange={e => setManualOnly(e.target.checked)} />
              手动运行
            </label>
            {!manualOnly && (
              <label style={styles.intervalLabel}>
                每
                <input
                  type="number"
                  min={5}
                  value={intervalMinutes}
                  onChange={e => setIntervalMinutes(Number(e.target.value))}
                  style={styles.numberInput}
                />
                分钟
              </label>
            )}
            <button style={styles.primaryBtn} disabled={!title.trim() || !goal.trim()} onClick={createTask}>保存</button>
          </div>
        </div>
      )}

      {tasks.length === 0 && <div style={styles.empty}>暂无后台任务。你可以手动新建，也可以在聊天里让宠物“每隔一小时帮我检查...”</div>}

      {tasks.map(task => (
        <div key={task.id} style={styles.card}>
          <div style={styles.cardTop}>
            <div style={{ minWidth: 0 }}>
              <div style={styles.titleRow}>
                <span style={styles.title}>{task.title}</span>
                <span style={{
                  ...styles.badge,
                  background: !task.approved ? 'rgba(226,92,82,0.12)' : task.enabled ? 'rgba(73,160,92,0.14)' : 'var(--hover)',
                  color: !task.approved ? '#b5463d' : task.enabled ? 'var(--good)' : 'var(--text-3)',
                }}>{statusLabel(task)}</span>
              </div>
              <div style={styles.goal}>{task.goal}</div>
            </div>
            <div style={styles.actions}>
              {!task.approved && <button style={styles.smallBtn} onClick={async () => { await ipc.invoke(IPC.AGENT_TASKS_APPROVE, task.id); await reload() }}>审批</button>}
              <button style={styles.smallBtn} onClick={async () => { await ipc.invoke(IPC.AGENT_TASKS_RUN, task.id); await reload() }}>运行</button>
              <button
                style={styles.smallBtn}
                onClick={async () => {
                  await ipc.invoke(IPC.AGENT_TASKS_UPDATE, { id: task.id, patch: { enabled: !task.enabled } })
                  await reload()
                }}
              >
                {task.enabled ? '停用' : '启用'}
              </button>
              <button style={styles.dangerBtn} onClick={async () => { await ipc.invoke(IPC.AGENT_TASKS_DELETE, task.id); await reload() }}>删除</button>
            </div>
          </div>
          <div style={styles.meta}>
            <span>{task.schedule === 'interval' ? `每 ${task.intervalMinutes} 分钟` : '手动运行'}</span>
            <span>下次: {formatTime(task.nextRunAt)}</span>
            <span>上次: {formatTime(task.lastRunAt)}</span>
          </div>
          {(task.lastResult || task.lastError) && (
            <div style={task.lastError ? styles.errorBox : styles.resultBox}>
              {task.lastError || task.lastResult}
            </div>
          )}
        </div>
      ))}

      <h3 style={styles.sectionHeading}>最近运行</h3>
      {runs.length === 0 && <div style={styles.empty}>暂无运行记录</div>}
      {runs.slice(0, 8).map(run => (
        <div key={run.id} style={styles.runRow}>
          <span style={styles.runStatus}>{run.status}</span>
          <span style={styles.runText}>{formatTime(run.ts)} · {(run.result || run.error || '').slice(0, 80)}</span>
        </div>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16 },
  loading: { padding: 16, fontSize: 13, color: 'var(--text-3)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 14 },
  heading: { margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' },
  subtle: { margin: '4px 0 0', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 },
  primaryBtn: { border: 'none', background: 'var(--accent)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  form: { background: 'var(--elev)', border: '0.5px solid var(--hairline)', borderRadius: 8, padding: 12, marginBottom: 12 },
  input: { width: '100%', boxSizing: 'border-box', border: '0.5px solid var(--hairline)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', padding: '8px 10px', fontSize: 13, outline: 'none', marginBottom: 8 },
  textarea: { width: '100%', boxSizing: 'border-box', minHeight: 82, resize: 'vertical', border: '0.5px solid var(--hairline)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', padding: '8px 10px', fontSize: 13, outline: 'none', marginBottom: 8, fontFamily: 'var(--font)' },
  row: { display: 'flex', alignItems: 'center', gap: 12 },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' },
  intervalLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' },
  numberInput: { width: 64, border: '0.5px solid var(--hairline)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', padding: '4px 6px', fontSize: 12 },
  empty: { background: 'var(--elev)', border: '0.5px solid var(--hairline)', borderRadius: 8, padding: 12, color: 'var(--text-3)', fontSize: 12, marginBottom: 10 },
  card: { background: 'var(--elev)', border: '0.5px solid var(--hairline)', borderRadius: 8, padding: '12px 14px', marginBottom: 10 },
  cardTop: { display: 'flex', justifyContent: 'space-between', gap: 14 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 },
  title: { fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { fontSize: 10, borderRadius: 999, padding: '2px 7px', fontWeight: 700, flexShrink: 0 },
  goal: { fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 },
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', alignContent: 'flex-start', flexShrink: 0 },
  smallBtn: { background: 'var(--bg)', border: '0.5px solid var(--hairline)', borderRadius: 5, color: 'var(--text-2)', padding: '4px 8px', fontSize: 11, cursor: 'pointer' },
  dangerBtn: { background: 'transparent', border: '0.5px solid rgba(226,92,82,0.35)', borderRadius: 5, color: '#b5463d', padding: '4px 8px', fontSize: 11, cursor: 'pointer' },
  meta: { display: 'flex', gap: 12, color: 'var(--text-3)', fontSize: 10, marginTop: 8, flexWrap: 'wrap' },
  resultBox: { marginTop: 8, background: 'rgba(73,160,92,0.08)', borderRadius: 6, padding: 8, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 },
  errorBox: { marginTop: 8, background: 'rgba(226,92,82,0.08)', borderRadius: 6, padding: 8, fontSize: 12, color: '#b5463d', lineHeight: 1.5 },
  sectionHeading: { fontSize: 13, fontWeight: 700, margin: '18px 0 8px', color: 'var(--text)' },
  runRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '0.5px solid var(--hairline)', fontSize: 12 },
  runStatus: { width: 56, color: 'var(--text-3)', fontSize: 10, textTransform: 'uppercase' },
  runText: { color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}
