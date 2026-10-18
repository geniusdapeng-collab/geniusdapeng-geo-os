export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PolicyError extends ApiError {
  constructor(code, message, findings = []) {
    super(409, code, message, { findings });
    this.name = "PolicyError";
  }
}
