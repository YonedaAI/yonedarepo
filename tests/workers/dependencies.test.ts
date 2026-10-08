import {expect,it} from 'vitest';
it('allows only read-only registry downloads with credentials removed',async()=>{
 const {dependencyRequest} = await import('../../worker/dependencies');
 const job = {kind:'evaluate'};
 const result = dependencyRequest(new Request('https://registry.npmjs.org/react/-/react-19.0.0.tgz',{headers:{authorization:'secret',cookie:'private'}}),job);
 expect(result.url).toBe('https://registry.npmjs.org/react/-/react-19.0.0.tgz');
 expect(result.headers.has('authorization')).toBe(false); expect(result.headers.has('cookie')).toBe(false);
 expect(() => dependencyRequest(new Request('https://evil.example/steal'),job)).toThrow();
 expect(() => dependencyRequest(new Request('https://registry.npmjs.org/package',{method:'POST',body:'publish'}),job)).toThrow();
 expect(() => dependencyRequest(new Request('https://registry.npmjs.org/package'),{kind:'publish'})).toThrow();
});
