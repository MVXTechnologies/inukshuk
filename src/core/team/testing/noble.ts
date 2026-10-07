/** TEST-ONLY: the production noble implementation, fed by Node's CSPRNG. */
import { randomFillSync } from 'node:crypto';

import { createNobleCrypto } from '../nobleCrypto';

export const nobleCrypto = createNobleCrypto((buffer) => {
  randomFillSync(buffer);
});
