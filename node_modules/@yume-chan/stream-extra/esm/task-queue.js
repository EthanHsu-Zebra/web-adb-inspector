import { isPromiseLike } from "@yume-chan/async";
export class TaskQueue {
    #ready;
    #disposed = false;
    enqueue(task, bail = false) {
        if (this.#disposed) {
            throw new Error("TaskQueue is disposed");
        }
        if (!this.#ready) {
            // Init state or all previous tasks are synchronous
            try {
                const result = task();
                if (isPromiseLike(result)) {
                    this.#ready = result.then(() => { }, (e) => {
                        if (bail) {
                            throw e;
                        }
                    });
                }
                return result;
            }
            catch (e) {
                if (bail) {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                    const promise = Promise.reject(e);
                    // Suppress unhandled-rejection without resolving `#ready`
                    void promise.catch(() => { });
                    this.#ready = promise;
                }
                throw e;
            }
        }
        const result = this.#ready.then(() => {
            if (this.#disposed) {
                throw new Error("TaskQueue is disposed");
            }
            return task();
        });
        this.#ready = result.then(() => { }, (e) => {
            if (bail || this.#disposed) {
                throw e;
            }
        });
        return result;
    }
    dispose() {
        this.#disposed = true;
    }
}
//# sourceMappingURL=task-queue.js.map