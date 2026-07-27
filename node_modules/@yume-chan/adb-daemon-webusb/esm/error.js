export class DeviceBusyError extends Error {
    constructor(cause) {
        super("The device is already in used by another program", {
            cause,
        });
    }
}
//# sourceMappingURL=error.js.map