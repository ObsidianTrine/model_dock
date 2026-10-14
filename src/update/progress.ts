/**
 * 更新进度状态文件（update-progress.json）：`modeldock update --yes` 子进程是唯一写方，
 * 托盘进度窗与 Web 控制台是读方——下载/校验/替换/拉起各阶段与下载字节进度在此暴露，
 * 更新期间「界面毫无动静」的体验问题由此收敛。瞬态数据：超过 STALE_MS 未更新的文件按
 * 上次更新的残留处理（读方视为无进度）。
 */
import path from 'node:path'
import { atomicWrite, readTextIfExists } from '../util/fsx.js'
import { modeldockDir } from '../util/paths.js'

export type UpdateStage = 'downloading' | 'verifying' | 'swapping' | 'restarting' | 'done' | 'failed'

export interface UpdateProgress {
  stage: UpdateStage
  received: number
  total: number
  percent: number
  error: string | null
  /** 写入时间戳：读方据此识别残留文件 */
  at: number
}

const STALE_MS = 10 * 60_000

export function updateProgressPath(): string {
  return path.join(modeldockDir(), 'update-progress.json')
}

// 节流状态（写方是单进程单飞，模块级即可）
let lastWriteAt = 0
let lastPercent = -1
let lastStage: UpdateStage | null = null

/** 写进度。节流规则：阶段变化立即落盘；同阶段百分比变化 200ms 合并（读方最多滞后一次调用）；
 *  无变化每 5s 心跳刷新 at（让读方的 stale 窗口知道下载仍活着）。终态（done/failed）总是写。
 *  落盘失败静默——进度展示是锦上添花，绝不能影响更新主流程。 */
export async function writeUpdateProgress(stage: UpdateStage, received = 0, total = 0, error?: string): Promise<void> {
  const now = Date.now()
  const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : stage === 'done' ? 100 : 0
  const terminal = stage === 'done' || stage === 'failed'
  const stageChanged = stage !== lastStage
  const percentChanged = percent !== lastPercent
  if (!terminal && !stageChanged) {
    if (!percentChanged && now - lastWriteAt < 5000) return // 无变化：5s 心跳刷 at
    if (now - lastWriteAt < 200) return                     // 有变化：200ms 合并
  }
  lastWriteAt = now
  lastPercent = percent
  lastStage = stage
  const payload: UpdateProgress = { stage, received, total, percent, error: error ?? null, at: now }
  try {
    await atomicWrite(updateProgressPath(), JSON.stringify(payload) + '\n', 0o600)
  } catch {
    /* 忽略 */
  }
}

/** 读进度：缺失 / 损坏 / 超过 STALE_MS 未更新（上次更新的残留）返回 null。 */
export async function readUpdateProgress(): Promise<UpdateProgress | null> {
  const text = await readTextIfExists(updateProgressPath())
  if (!text) return null
  try {
    const p = JSON.parse(text) as UpdateProgress
    if (!p || typeof p.stage !== 'string') return null
    if (Date.now() - (p.at ?? 0) > STALE_MS) return null
    return p
  } catch {
    return null
  }
}

/** 测试专用：清空节流状态（跨用例泄漏会让节流吞掉断言期望的写入）。 */
export function resetUpdateProgressThrottleForTests(): void {
  lastWriteAt = 0
  lastPercent = -1
  lastStage = null
}
