const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const express=require('express');
const request=require('supertest');
const {migrate,createPublications,registerRoutes}=require('../lib/publications');
let db,service,calls,handler;
const deps=()=>({pool:db,accountId:'test-account',publicBaseUrl:'https://example.test',wait:async()=>{},
  igRequest:async(path,options)=>{calls.push([path,options]);return handler(path,options);}});
before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE TABLE imagenes_marketing(id BIGSERIAL PRIMARY KEY);
    INSERT INTO imagenes_marketing DEFAULT VALUES;
    CREATE TABLE publicaciones_instagram(id BIGSERIAL PRIMARY KEY,image_url TEXT NOT NULL,caption TEXT NOT NULL DEFAULT '',
      scheduled_at TIMESTAMPTZ NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'programada',instagram_media_id VARCHAR(100),
      error TEXT,published_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await migrate(db);
});
after(async()=>db.close());
beforeEach(async()=>{
  await db.exec('TRUNCATE publicacion_eventos,publicaciones_instagram RESTART IDENTITY CASCADE');
  calls=[];
  handler=async path=>path.endsWith('/media_publish')?{id:'published-1'}:path.endsWith('/media')?{id:'container-1'}:{status_code:'FINISHED'};
  service=createPublications(deps());
});
const payload={request_id:'draft-request-0001',image_id:1,caption:'Consultorio piloto: pedí información'};
async function approved(){const p=await service.create(payload);return service.approve(p.id,{revision:p.revision,confirmacion:true});}

test('borrador idempotente y conflicto si se reutiliza la clave con otra pieza',async()=>{
  const [a,b]=await Promise.all([service.create(payload),service.create(payload)]);
  assert.equal(a.id,b.id);assert.equal(a.status,'borrador');
  await assert.rejects(service.create({...payload,caption:'Otro texto'}),{status:409});
});
test('no publica ni programa sin aprobación',async()=>{
  const p=await service.create(payload);
  await assert.rejects(service.publish(p.id,1),{status:409});
  await assert.rejects(service.schedule(p.id,{revision:1,scheduled_at:'2099-01-01T18:00:00-03:00'}),{status:409});
  assert.equal(calls.length,0);
});
test('aprobación requiere confirmación, revisión exacta y es repetible sin duplicar auditoría',async()=>{
  const p=await service.create(payload);
  await assert.rejects(service.approve(p.id,{revision:1}),{status:400});
  await assert.rejects(service.approve(p.id,{revision:2,confirmacion:true}),{status:409});
  await service.approve(p.id,{revision:1,confirmacion:true});
  await service.approve(p.id,{revision:1,confirmacion:true});
  assert.equal((await db.query('SELECT * FROM publicacion_eventos')).rows.length,1);
});
test('editar invalida aprobación y retira la programación',async()=>{
  const p=await approved();
  await service.schedule(p.id,{revision:1,scheduled_at:'2099-01-01T18:00:00-03:00'});
  const edited=await service.edit(p.id,{revision:1,image_id:1,caption:'Nuevo copy'});
  assert.equal(edited.status,'borrador');assert.equal(edited.revision,2);assert.equal(edited.approved_revision,null);assert.equal(edited.scheduled_at,null);
  await assert.rejects(service.publish(p.id,1),{status:409});
  await assert.rejects(service.publish(p.id,2),{status:409});
});
test('rechaza fechas pasadas y sin zona; normaliza Argentina y permite reprogramar',async()=>{
  const p=await approved();
  for(const scheduled_at of ['2000-01-01T18:00:00-03:00','2099-01-01T18:00:00','basura']) {
    await assert.rejects(service.schedule(p.id,{revision:1,scheduled_at}),{status:400});
  }
  const result=await service.schedule(p.id,{revision:1,scheduled_at:'2099-01-01T18:00:00-03:00'});
  assert.equal(new Date(result.scheduled_at).toISOString(),'2099-01-01T21:00:00.000Z');
  const changed=await service.schedule(p.id,{revision:1,scheduled_at:'2099-02-01T18:00:00-03:00'});
  assert.equal(changed.status,'programada');
});
test('cancelación es repetible y evita publicación',async()=>{
  const p=await approved();
  await service.cancel(p.id,{revision:1});await service.cancel(p.id,{revision:1});
  await assert.rejects(service.publish(p.id,1),{status:409});assert.equal(calls.length,0);
});
test('dos publicaciones manuales y el cron comparten una sola reserva',async()=>{
  const p=await approved();
  await db.query("UPDATE publicaciones_instagram SET status='programada',scheduled_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[p.id]);
  let release,started;
  const gate=new Promise(r=>release=r),start=new Promise(r=>started=r);
  handler=async path=>{if(path.endsWith('/media')){started();await gate;return {id:'container-1'};}return path.endsWith('/media_publish')?{id:'published-1'}:{status_code:'FINISHED'};};
  const first=service.publish(p.id,1);await start;
  await assert.rejects(service.publish(p.id,1),{status:409});
  await assert.rejects(service.cancel(p.id,{revision:1}),{status:409});
  const cron=await service.processDue();assert.equal(cron.procesadas,0);
  release();assert.equal((await first).status,'publicada');
  assert.equal(calls.filter(c=>c[0].endsWith('/media_publish')).length,1);
  await service.publish(p.id,1);
  assert.equal(calls.filter(c=>c[0].endsWith('/media_publish')).length,1);
});
test('timeout de publicación queda en revisión y no se reenvía; consulta confirma PUBLISHED',async()=>{
  const p=await approved();
  handler=async path=>{if(path.endsWith('/media_publish'))throw new Error('timeout secret-token');return path.endsWith('/media')?{id:'container-1'}:{status_code:'FINISHED'};};
  await assert.rejects(service.publish(p.id,1),{status:502});
  let state=await service.get(p.id);assert.equal(state.status,'revision');assert.equal(state.container_id,'container-1');assert.ok(!state.error.includes('secret-token'));
  await assert.rejects(service.publish(p.id,1),{status:409});
  handler=async()=>({status_code:'PUBLISHED'});
  assert.equal((await service.reconcile(p.id)).publicacion.status,'publicada');
});
test('fallo al guardar después de publicar conserva el contenedor y evita duplicado',async()=>{
  const p=await approved();let failed=false;
  const pool={query:async(sql,args)=>{if(sql.includes("status='publicada',instagram_media_id")&&!failed){failed=true;throw new Error('DB unavailable');}return db.query(sql,args);}};
  const faulty=createPublications({...deps(),pool});
  await assert.rejects(faulty.publish(p.id,1),{status:502});
  await assert.rejects(service.publish(p.id,1),{status:409});
  assert.equal((await service.get(p.id)).container_id,'container-1');
  assert.equal(calls.filter(c=>c[0].endsWith('/media_publish')).length,1);
});
test('proceso interrumpido se aísla y cron informa error HTTP',async()=>{
  const p=await approved();
  await db.query("UPDATE publicaciones_instagram SET status='publicando',container_id='container-1',updated_at=NOW()-INTERVAL '16 minutes' WHERE id=$1",[p.id]);
  const app=express();app.use(express.json());registerRoutes(app,deps());
  const result=await request(app).post('/api/instagram/procesar-programadas').expect(503);
  assert.equal(result.body.ok,false);assert.equal(result.body.requieren_revision,1);assert.equal(calls.length,0);
  const next=await request(app).post('/api/instagram/procesar-programadas').expect(200);
  assert.equal(next.body.requieren_revision,1);
});
test('cron no adelanta publicaciones y respeta la cuenta aprobada',async()=>{
  const p=await approved();await service.schedule(p.id,{revision:1,scheduled_at:'2099-01-01T18:00:00-03:00'});
  assert.equal((await service.processDue()).procesadas,0);
  const other=createPublications({...deps(),accountId:'other-account'});
  await assert.rejects(other.publish(p.id,1),{status:409});
});
test('la migración preserva colas anteriores y no inventa aprobación humana',async()=>{
  await db.query("INSERT INTO publicaciones_instagram(image_url,status,scheduled_at) VALUES ('https://example.test/old.jpg','programada',NOW())");
  await migrate(db);await migrate(db);
  const old=(await db.query('SELECT * FROM publicaciones_instagram')).rows[0];
  assert.equal(old.status,'programada');assert.equal(old.approval_source,'legacy_pre_v35');assert.equal(old.approved_at,null);
});
test('listado paginado, consulta por id y acción combinada retirada',async()=>{
  const p=await approved();await service.create({...payload,request_id:'draft-request-0002'});
  const app=express();app.use(express.json());registerRoutes(app,deps());
  const first=await request(app).get('/api/instagram/programaciones?limite=1').expect(200);
  const second=await request(app).get(`/api/instagram/programaciones?limite=1&before_id=${first.body.next_before_id}`).expect(200);
  assert.equal(second.body.publicaciones[0].id,p.id);
  await request(app).get(`/api/instagram/programaciones/${p.id}`).expect(200);
  await request(app).post('/api/instagram/generar-y-programar').send({}).expect(410);
  await request(app).post('/api/instagram/publicar-imagen').send({image_url:'https://example.test/a.jpg'}).expect(400);
});
