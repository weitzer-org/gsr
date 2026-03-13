import { PromisePool } from '../src/pool';

describe('PromisePool', () => {
    it('should limit concurrency to the max specified', async () => {
        const pool = new PromisePool(2);
        let activeCount = 0;
        let maxActiveObserved = 0;

        const createTask = (delayMs: number) => {
            return async () => {
                activeCount++;
                if (activeCount > maxActiveObserved) {
                    maxActiveObserved = activeCount;
                }
                const start = Date.now();
                // Simulate async work
                while (Date.now() - start < delayMs) {
                    await new Promise(r => setTimeout(r, 10));
                }
                activeCount--;
                return 'done';
            };
        };

        const tasks = [
            pool.add(createTask(50)),
            pool.add(createTask(50)),
            pool.add(createTask(50)),
            pool.add(createTask(50))
        ];

        await Promise.all(tasks);
        expect(maxActiveObserved).toBeLessThanOrEqual(2);
    });

    it('should resolve tasks correctly', async () => {
        const pool = new PromisePool(2);
        const task1 = async () => 'result1';
        const task2 = async () => 'result2';

        const p1 = pool.add(task1);
        const p2 = pool.add(task2);

        expect(await p1).toBe('result1');
        expect(await p2).toBe('result2');
    });

    it('should handle rejections without stopping the pool', async () => {
        const pool = new PromisePool(1);
        const task1 = async () => { throw new Error('Task 1 failed'); };
        const task2 = async () => 'Task 2 success';

        await expect(pool.add(task1)).rejects.toThrow('Task 1 failed');
        const res2 = await pool.add(task2);
        expect(res2).toBe('Task 2 success');
    });
});
