export interface Block {
  timestamp: string;
  peak: boolean;
  wh: number;
}
export function monthBlocks(year: number, month: number, holidays?: string[]): Block[];
export function buildMonth(options: {
  year: number;
  month: number;
  peakWh: number;
  offPeakWh: number;
  fixed?: { timestamp: string; wh: number }[];
  holidays?: string[];
}): Block[];
export function toCsv(blocks: Block[], intervalMinutes?: 15 | 30): string;
export const FIXTURES: Record<string, () => string>;
