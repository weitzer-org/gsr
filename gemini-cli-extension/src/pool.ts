/**
 * A simple promise pool to limit the maximum number of concurrent async tasks.
 */
export class PromisePool {
  private queue: (() => Promise<void>)[] = [];
  private activeCount = 0;

  constructor(private readonly maxConcurrency: number) {}

  /**
   * Adds a task to the pool. The task will be executed once concurrency allows.
   * @param task A function returning a promise.
   * @returns A promise that resolves exactly when the task itself resolves.
   */
  async add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const wrappedTask = async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeCount--;
          this.next(); // Trigger the next task if waiting
        }
      };

      this.queue.push(wrappedTask);
      this.next(); // Try to start the task immediately
    });
  }

  private next() {
    if (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.activeCount++;
        task();
      }
    }
  }
}
