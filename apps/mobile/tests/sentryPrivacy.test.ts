import assert from 'node:assert/strict';
import test from 'node:test';
import { scrubSentryEvent, scrubBreadcrumb, diagnosticRoute } from '../src/sentryPrivacy.ts';

test('diagnostics keep account ID and safe breadcrumbs while removing record contents and credentials', () => {
  const event = {
    request: { url: 'https://merosplit.com/j/private-token', headers: { Authorization: 'secret' } },
    user: { id: '80', email: 'private@example.test', username: 'Private name', ip_address:'192.0.2.1' },
    extra: { bill: 'Private bill' }, breadcrumbs: [{ message: 'Private note' },{category:'fetch',type:'http',data:{url:'https://merosplit.com/api/v1/groups/private-token/expenses?token=secret',method:'POST',status_code:409,body:'Private bill'}}],
    message: 'Private message', transaction: 'POST /api/v1/groups/private-token/expenses',
    contexts:{trace:{trace_id:'a'.repeat(32),data:{token:'secret'}},device:{model:'Pixel',name:'Private phone'},custom:{note:'Private note'}},
    tags:{'app.platform':'android',bad:'Private note'},
    exception: { values: [{ type: 'TypeError', value: 'Private bill', stacktrace: { frames: [{ filename: 'App.tsx', lineno: 42, vars: { token: 'secret' }, context_line: 'private' }] } }] },
  };
  const result = scrubSentryEvent(event),payload=JSON.stringify(result);
  for (const value of ['private-token','secret','Private','private@example','context_line','192.0.2.1']) assert.equal(payload.includes(value),false,value);
  assert.deepEqual(result.user,{id:'80'});assert.equal(result.breadcrumbs.length,1);assert.equal(result.breadcrumbs[0].data?.url,'/api/v1/groups/:id/expenses');
  assert.equal(result.exception.values[0].type,'TypeError');assert.equal(result.exception.values[0].stacktrace.frames[0].lineno,42);
});
test('performance traces preserve timing and IDs without SQL, headers, dynamic routes or arbitrary span attributes',()=>{
 const event:any={type:'transaction',transaction:'GET /api/v1/groups/private-name/summary?token=secret',user:{id:'80',email:'private@example.test'},start_timestamp:1,timestamp:2,spans:[{op:'db.query',description:'SELECT private WHERE password=secret',span_id:'1'.repeat(16),start_timestamp:1,timestamp:1.5,data:{'db.params':['private'],'http.response.status_code':200},tags:{note:'private'}},{op:'http.client',description:'GET https://merosplit.com/j/private-token?key=secret',data:{'http.request.method':'GET','http.url':'private','request.headers':'secret'}}]};
 const result=scrubSentryEvent(event);assert.equal(result.timestamp,2);assert.equal(result.spans[0].timestamp,1.5);assert.equal(result.spans[0].description,'db.query');assert.equal(result.spans[1].description,'/:id/:id');assert.equal(/private|secret|SELECT/.test(JSON.stringify(result)),false);
});
test('breadcrumbs discard console text, UI labels, SQL and navigation titles; keep bounded sync metadata',()=>{
 for(const category of ['console','ui.click','navigation','query'])assert.equal(scrubBreadcrumb({category,message:'private',data:{sql:'secret'}} as any),null);
 const crumb=scrubBreadcrumb({category:'sync',message:'private',data:{phase:'failed',pending_count:3,status:409,bill:'private',token:'secret'}} as any)!;
 assert.deepEqual(crumb.data,{phase:'failed',pending_count:3,status:409});assert.equal(JSON.stringify(crumb).includes('private'),false);
 const event=scrubSentryEvent({breadcrumbs:Array(60).fill(crumb)});assert.equal(event.breadcrumbs.length,50);
});
test('invalid identifiers and external signed URLs cannot reach diagnostic payloads',()=>{
 assert.equal(diagnosticRoute('https://storage.example.test/private?signature=secret'),'/external');
 assert.equal(diagnosticRoute('POST /_allauth/app/v1/auth/link/private-token?proof=secret'),'/_allauth/app/v1/auth/link/:id');
 for(const id of ['private@example.test','80\nsecret','0',null]){const event=scrubSentryEvent({user:{id}});assert.equal('user' in event,false);}
});
