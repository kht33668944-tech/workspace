/**
 * 브라우저 인스턴스 동시성 제어 (Semaphore 패턴)
 * Railway 환경에서 메모리 초과 방지
 */
class BrowserPool {
  private running = 0;
  private readonly maxConcurrency: number;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  get currentLoad(): number {
    return this.running;
  }

  get queueLength(): number {
    return this.waitQueue.length;
  }
}

export const browserPool = new BrowserPool(
  parseInt(process.env.MAX_BROWSER_INSTANCES || "2", 10)
);
