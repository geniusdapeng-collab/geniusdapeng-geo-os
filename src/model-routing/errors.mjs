export class ModelDispatchError extends Error {
  constructor(code, message, {
    unknown = false,
    retryable = false,
    httpStatus,
    cause,
    metering,
    usageReceipt,
    providerRequestId,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelDispatchError";
    this.code = code;
    this.unknown = unknown;
    this.retryable = retryable;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (metering !== undefined) this.metering = metering;
    if (usageReceipt !== undefined) this.usageReceipt = usageReceipt;
    if (providerRequestId !== undefined) this.providerRequestId = providerRequestId;
  }
}

export function modelError(code, message, options) {
  return new ModelDispatchError(code, message, options);
}
