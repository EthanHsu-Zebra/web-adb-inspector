export function isErrorName(e, name) {
    // node-usb package doesn't use `DOMException`,
    // so use a looser check
    // https://github.com/node-usb/node-usb/issues/573
    return (typeof e === "object" && e !== null && "name" in e && e.name === name);
}
export function isUsbInterfaceFilter(filter) {
    return (filter.classCode !== undefined &&
        filter.subclassCode !== undefined &&
        filter.protocolCode !== undefined);
}
function matchUsbInterfaceFilter(alternate, filter) {
    return (alternate.interfaceClass === filter.classCode &&
        alternate.interfaceSubclass === filter.subclassCode &&
        alternate.interfaceProtocol === filter.protocolCode);
}
export function findUsbInterface(device, filter) {
    for (const configuration of device.configurations) {
        for (const interface_ of configuration.interfaces) {
            for (const alternate of interface_.alternates) {
                if (matchUsbInterfaceFilter(alternate, filter)) {
                    return { configuration, interface_, alternate };
                }
            }
        }
    }
    return undefined;
}
function padNumber(value) {
    return value.toString(16).padStart(4, "0");
}
export function getSerialNumber(device) {
    if (device.serialNumber) {
        return device.serialNumber;
    }
    return padNumber(device.vendorId) + "x" + padNumber(device.productId);
}
/**
 * Find the first pair of input and output endpoints from an alternate interface.
 *
 * ADB interface only has two endpoints, one for input and one for output.
 */
export function findUsbEndpoints(endpoints) {
    if (endpoints.length === 0) {
        throw new TypeError("No endpoints given");
    }
    let inEndpoint;
    let outEndpoint;
    for (const endpoint of endpoints) {
        switch (endpoint.direction) {
            case "in":
                inEndpoint = endpoint;
                if (outEndpoint) {
                    return { inEndpoint, outEndpoint };
                }
                break;
            case "out":
                outEndpoint = endpoint;
                if (inEndpoint) {
                    return { inEndpoint, outEndpoint };
                }
                break;
        }
    }
    if (!inEndpoint) {
        throw new TypeError("No input endpoint found.");
    }
    if (!outEndpoint) {
        throw new TypeError("No output endpoint found.");
    }
    throw new Error("unreachable");
}
export function matchFilter(device, filter) {
    if (filter.vendorId !== undefined && device.vendorId !== filter.vendorId) {
        return false;
    }
    if (filter.productId !== undefined &&
        device.productId !== filter.productId) {
        return false;
    }
    if (filter.serialNumber !== undefined &&
        getSerialNumber(device) !== filter.serialNumber) {
        return false;
    }
    if (isUsbInterfaceFilter(filter)) {
        return findUsbInterface(device, filter) || false;
    }
    return true;
}
export function matchFilters(device, filters, exclusionFilters) {
    if (exclusionFilters && exclusionFilters.length > 0) {
        if (matchFilters(device, exclusionFilters)) {
            return false;
        }
    }
    for (const filter of filters) {
        const result = matchFilter(device, filter);
        if (result) {
            return result;
        }
    }
    return false;
}
//# sourceMappingURL=utils.js.map