import { DemoUserRequiredError } from './document-archive.errors.js';

export type DemoUser = 'alice' | 'bob';

const DEMO_USERS: readonly DemoUser[] = ['alice', 'bob'];

export function parseDemoUser(header: string | undefined): DemoUser {
  if (header !== undefined && (DEMO_USERS as readonly string[]).includes(header)) {
    return header as DemoUser;
  }
  throw new DemoUserRequiredError(header);
}
