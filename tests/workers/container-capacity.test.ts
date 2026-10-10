import { expect, it } from 'vitest';
import { capacityUnavailable } from '../../cloudflare/worker/container-capacity';
it('refunds only SDK errors proving no container allocation, not runtime or arbitrary boot failures',()=>{
 expect(capacityUnavailable(new Error('There is no container instance that can be provided to this durable object'))).toBe(true);
 expect(capacityUnavailable(new Error('You are requesting too many containers per second'))).toBe(true);
 expect(capacityUnavailable(new Error('Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances'))).toBe(true);
 for(const message of ['Container rejected job','Port ready timeout','Container exited with unexpected exit code: 1','Network reset','capacity exceeded during execution']) expect(capacityUnavailable(new Error(message))).toBe(false);
});
