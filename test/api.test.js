const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {PGlite}=require('@electric-sql/pglite');
const sharp=require('sharp');
const request=require('supertest');
const YAML=require('yaml');
let db,app,cloudCalls=0;
before(async()=>{
  db=new PGlite();
  const bg=await sharp({create:{width:1024,height:1280,channels:3,background:'#bedccf'}}).png().toBuffer();
  const filename=path.resolve(__dirname,'../server.js');
  const originalRequire=createRequire(filename);
  const module={exports:{}};
  const sandbox={module,Buffer,URL,URLSearchParams,AbortSignal,setTimeout,console,
    process:{env:{ACTION_API_KEY:'local-test-key',DATABASE_URL:'local-test-db',INSTAGRAM_ACCOUNT_ID:'test-account',INSTAGRAM_ACCESS_TOKEN:'test-token',CLOUDFLARE_ACCOUNT_ID:'test-cf',CLOUDFLARE_API_TOKEN:'test-token'},exit:()=>{throw new Error('exit');}},
    require:name=>name==='pg'?{Pool:class{query(...args){return db.query(...args);}}}:name==='dotenv'?{config(){}}:originalRequire(name),
    fetch:async url=>{assert.ok(String(url).startsWith('https://api.cloudflare.com/'));cloudCalls++;return {ok:true,status:200,json:async()=>({success:true,result:{image:bg.toString('base64')}})};}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{filename});
  await module.exports.init();app=module.exports.app;
});
after(async()=>db.close());
const auth=req=>req.set('Authorization','Bearer local-test-key');
test('health comprueba base y API rechaza peticiones sin autenticación',async()=>{
  const r=await request(app).get('/health').expect(200);assert.equal(r.body.version,'3.6.0');
  await request(app).get('/api/imagenes').expect(401);
  await request(app).post('/api/instagram/procesar-programadas').expect(401);
});
test('generar, reintentar y editar texto conserva fondo sin volver a llamar a Cloudflare',async()=>{
  const body={request_id:'image-request-0001',prompt:'Consultorio luminoso',title:'Organizá tu consultorio',cta:'Pedí información'};
  const first=await auth(request(app).post('/api/imagenes/generar')).send(body).expect(201);
  const second=await auth(request(app).post('/api/imagenes/generar')).send(body).expect(200);
  assert.equal(first.body.imagen.id,second.body.imagen.id);assert.equal(cloudCalls,1);
  await auth(request(app).post('/api/imagenes/generar')).send({...body,title:'Otro'}).expect(409);
  const edit={request_id:'image-edit-000001',title:'Probá Sismed durante 3 días',cta:'Pedí información'};
  const changed=await auth(request(app).post(`/api/imagenes/${first.body.imagen.id}/textos`)).send(edit).expect(201);
  const repeated=await auth(request(app).post(`/api/imagenes/${first.body.imagen.id}/textos`)).send(edit).expect(200);
  assert.equal(changed.body.imagen.id,repeated.body.imagen.id);assert.notEqual(changed.body.imagen.id,first.body.imagen.id);assert.equal(cloudCalls,1);
  const rows=(await db.query('SELECT id,image_data,background_data FROM imagenes_marketing ORDER BY id')).rows;
  assert.deepEqual(rows[0].background_data,rows[1].background_data);assert.notDeepEqual(rows[0].image_data,rows[1].image_data);
  const media=await request(app).get(`/media/generated/${first.body.imagen.id}.jpg`).expect(200);
  assert.match(media.headers['content-type'],/image\/jpeg/);
});
test('texto excesivo se rechaza antes de consumir generación',async()=>{
  const beforeCalls=cloudCalls;
  await auth(request(app).post('/api/imagenes/generar')).send({request_id:'image-overflow-001',prompt:'Consultorio',title:'W'.repeat(180),subtitle:'W'.repeat(320),bullets:Array(4).fill('W'.repeat(140)),cta:'W'.repeat(80)}).expect(422);
  assert.equal(cloudCalls,beforeCalls);
});
test('flujo HTTP guarda borrador, exige aprobación, programa y cancela',async()=>{
  const image=(await db.query('SELECT id FROM imagenes_marketing LIMIT 1')).rows[0];
  const draft=await auth(request(app).post('/api/instagram/borradores')).send({request_id:'api-draft-0000001',image_id:Number(image.id),caption:'Buscamos un consultorio piloto'}).expect(200);
  const id=draft.body.id;
  await auth(request(app).post('/api/instagram/programaciones')).send({publication_id:Number(id),revision:1,scheduled_at:'2099-01-01T18:00:00-03:00'}).expect(409);
  await auth(request(app).post(`/api/instagram/programaciones/${id}/aprobar`)).send({revision:1,confirmacion:true}).expect(200);
  await auth(request(app).post('/api/instagram/programaciones')).send({publication_id:Number(id),revision:1,scheduled_at:'2099-01-01T18:00:00-03:00'}).expect(200);
  const cancelled=await auth(request(app).post(`/api/instagram/programaciones/${id}/cancelar`)).send({revision:1}).expect(200);assert.equal(cancelled.body.status,'cancelada');
  await auth(request(app).post('/api/instagram/generar-y-programar')).send({}).expect(410);
});
test('esquema tiene referencias válidas, ids únicos y elimina acción combinada',()=>{
  const schema=YAML.parse(fs.readFileSync(path.resolve(__dirname,'../openapi.yaml'),'utf8'));
  const ids=[];
  for(const item of Object.values(schema.paths))for(const [method,operation] of Object.entries(item)){
    if(!['get','post','patch','delete'].includes(method))continue;
    ids.push(operation.operationId);
  }
  assert.equal(ids.length,new Set(ids).size);assert.ok(!ids.includes('generarYProgramarInstagram'));
  for(const name of ['crearBorradorInstagram','aprobarPublicacionInstagram','editarTextosImagenMarketing','cancelarPublicacionInstagram','verificarResultadoInstagram'])assert.ok(ids.includes(name));
  const walk=value=>{if(!value||typeof value!=='object')return;if(value.$ref){let target=schema;for(const segment of value.$ref.slice(2).split('/'))target=target?.[segment];assert.ok(target,value.$ref);}for(const child of Object.values(value))walk(child);};walk(schema);
});
