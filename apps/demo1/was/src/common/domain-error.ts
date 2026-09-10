export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;

  get shouldReport(): boolean {
    return this.status >= 500;
  }
}
