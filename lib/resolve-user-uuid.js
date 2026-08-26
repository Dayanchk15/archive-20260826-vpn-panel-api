import { v4 as uuidv4 } from 'uuid';

export function resolveUserUuid(customUuid) {
  if (customUuid) {
    return String(customUuid).trim().toLowerCase();
  }
  return uuidv4();
}
