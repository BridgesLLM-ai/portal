import { withPortalHostTurnAuthority, consumePortalHostTurnAuthority } from './portalHostTurnAuthority';
const actor='00000000-0000-4000-8000-000000000555';
const sessionKey=`agent:main:portal-${actor}-fixture`;
const handle={id:'host-run-fixture',actorUserId:actor,actorAuthorizationVersion:1,provider:'OPENCLAW' as const,executionScope:'HOST_OPERATOR' as const,sessionKey};
describe('per-admitted-Host-turn native creator authority',()=>{
 test('missing, foreign and reused authority cannot open a rich turn',async()=>{
  expect(()=>consumePortalHostTurnAuthority(sessionKey)).toThrow('unavailable');
  await withPortalHostTurnAuthority(handle,'OWNER',async()=>{
   expect(()=>consumePortalHostTurnAuthority(sessionKey+'-foreign')).toThrow('unavailable');
   const current=consumePortalHostTurnAuthority(sessionKey);expect(()=>current()).not.toThrow();
   expect(()=>consumePortalHostTurnAuthority(sessionKey)).toThrow('unavailable');
  });
 });
 test('a retained socket check expires on successful settlement',async()=>{
  let check:()=>void=()=>{throw Error('missing');};
  await withPortalHostTurnAuthority(handle,'OWNER',async()=>{check=consumePortalHostTurnAuthority(sessionKey);});
  expect(()=>check()).toThrow('expired');
 });
 test('failure revokes a captured socket capability too',async()=>{
  let check:()=>void=()=>{throw Error('missing');};
  await expect(withPortalHostTurnAuthority(handle,'SUB_ADMIN',async()=>{check=consumePortalHostTurnAuthority(sessionKey);throw Error('fixture failed');})).rejects.toThrow('fixture failed');
  expect(()=>check()).toThrow('expired');
 });
 test.each(['MEMBER','USER','UNSUPPORTED_ADMIN','ADMIN','',undefined])('non-elevated role %s is refused before callback',async role=>{
  const run=jest.fn(async()=>{});await expect(withPortalHostTurnAuthority(handle,role,run)).rejects.toThrow('unavailable');expect(run).not.toHaveBeenCalled();
 });
 test.each([
  'agent:p4oc-fixture:main','agent:portal:main','agent:portal-00000000-legacy:main',
  'agent:main:cron:job','agent:main:subagent:child','agent:main:group:room',
  'portal-00000000-0000-4000-8000-000000000555-project',
  'agent:main:portal-00000000-0000-4000-8000-000000000666-fixture'
 ])('Project/cron/child/group/foreign session %s cannot inherit Host creation',async key=>{
  const run=jest.fn(async()=>{});await expect(withPortalHostTurnAuthority({...handle,sessionKey:key},'OWNER',run)).rejects.toThrow('unavailable');expect(run).not.toHaveBeenCalled();
 });
 test.each([0,-1,NaN,1.5])('invalid authorization generation %s refuses',async version=>{
  await expect(withPortalHostTurnAuthority({...handle,actorAuthorizationVersion:version},'OWNER',async()=>{})).rejects.toThrow('unavailable');
 });
 test('concurrent turns cannot consume each other’s capability',async()=>{
  const other={...handle,id:'other-run',sessionKey:sessionKey+'-other'};
  let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
  await Promise.all([
   withPortalHostTurnAuthority(handle,'OWNER',async()=>{await wait;expect(()=>consumePortalHostTurnAuthority(other.sessionKey)).toThrow('unavailable');consumePortalHostTurnAuthority(sessionKey)();}),
   withPortalHostTurnAuthority(other,'OWNER',async()=>{expect(()=>consumePortalHostTurnAuthority(sessionKey)).toThrow('unavailable');consumePortalHostTurnAuthority(other.sessionKey)();release();})
  ]);
 });
});
