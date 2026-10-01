import type { DailyDriverRequest, DailyDriverResponse } from '../../shared/daily-driver-contract'

export type DailyDriverApi = {
  call: (request: DailyDriverRequest) => Promise<DailyDriverResponse>
}
