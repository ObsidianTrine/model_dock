import type { ProbeTransport } from './probe/engine.js'

export interface GatewayStartOptions {
  port: number
  idleTimeoutMs?: number
  retries?: number
  /** 法定节假日每年自动获取（holiday-cn 数据）；默认开启，测试传 false 避免 90s 首查触发出站请求 */
  autoHolidayRefresh?: boolean
  /** 模型元数据目录（models.dev）自动刷新；默认开启，测试传 false 避免出站请求 */
  autoCatalogRefresh?: boolean
  /** 上游模型可用性周期探测（modelprobe.ts，v1 纯观测）；默认开启，测试传 false 避免出站请求
   *  （或用 modelProbeIntervals 注入短首查 + mock 上游） */
  autoModelProbe?: boolean
  /** 注入探测调度节奏（测试用）：不传用 modelprobe.ts 的 MODEL_PROBE_* 默认（启动 90s / 每 24h） */
  modelProbeIntervals?: { initialDelayMs?: number; intervalMs?: number }
  /** 探针周期调度（probe/schedule.ts：P15 被动聚合恒跑 + cost_ack 授权的周期主动面）；默认开启，
   *  测试传 false 避免 tick 触发探针（或用 probeScheduleIntervals 注入短间隔 + mock 上游） */
  autoProbeSchedule?: boolean
  /** 注入探针调度节奏（测试用）：不传用 schedule.ts 的 PROBE_SCHEDULE_* 默认（启动 90s / 每 1h） */
  probeScheduleIntervals?: { initialDelayMs?: number; intervalMs?: number; transport?: ProbeTransport }
  /** 临时 harness TTL 清扫间隔（C14，测试注入用）：不传用 EPHEMERAL_SWEEP_INTERVAL_MS（60s） */
  ephemeralSweepIntervalMs?: number
}
