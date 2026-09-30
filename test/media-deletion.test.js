const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');const {PGlite}=require('@electric-sql/pglite');
const {migrateDeletion,createDeletion,registerDeletion}=require('../lib/media-deletion');
const express=require('express'),request=require('supertest');let db,service;
before(async()=>{
 db=new PGlite();await db.exec(`CREATE TABLE imagenes_marketing(id BIGINT PRIMARY KEY,image_data BYTEA,background_data BYTEA,created_at TIMESTAMPTZ DEFAULT NOW(),purged_at TIMESTAMPTZ);
 CREATE TABLE reels_marketing(id BIGINT PRIMARY KEY,image_ids JSONB,status TEXT,video_data BYTEA,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),purged_at TIMESTAMPTZ);
 CREATE TABLE publicaciones_instagram(id BIGINT PRIMARY KEY,image_id BIGINT,reel_id BIGINT,image_url TEXT,status TEXT,revision INTEGER);`);
 await migrateDeletion(db);service=createDeletion({pool:db,publicBaseUrl:'https://example.test'});
});
after(async()=>db.close());
beforeEach(async()=>{
 await db.exec(`TRUNCATE imagenes_marketing,reels_marketing,publicaciones_instagram,media_eliminaciones;
 INSERT INTO imagenes_marketing(id,image_data,background_data) VALUES(1,'abc','def'),(2,'ghi','jkl');
 INSERT INTO reels_marketing(id,image_ids,status,video_data) VALUES(1,'[1]','lista','abc'),(2,'[2]','lista','def');
 INSERT INTO publicaciones_instagram VALUES(7,NULL,1,'https://example.test/media/reels/1.mp4','cancelada',1),(8,NULL,2,'https://example.test/media/reels/2.mp4','borrador',1);`);
});
const confirm=p=>({confirmacion:true,revision_borrado:p.revision_borrado});
test('elimina únicamente archivo autorizado, conserva reel corregido e historial; repetir no duplica auditoría',async()=>{
 const p=await service.preview('reel',1);assert.equal(p.puede_eliminar,true);assert.equal(p.bytes_a_eliminar,3);
 await assert.rejects(service.remove('reel',1,{}),{status:400});
 const result=await service.remove('reel',1,confirm(p));assert.equal(result.bytes_eliminados,3);
 assert.equal((await db.query('SELECT video_data FROM reels_marketing WHERE id=1')).rows[0].video_data,null);
 assert.ok((await db.query('SELECT video_data FROM reels_marketing WHERE id=2')).rows[0].video_data);
 assert.equal((await db.query('SELECT status FROM publicaciones_instagram WHERE id=8')).rows[0].status,'borrador');
 assert.equal((await service.remove('reel',1,confirm(p))).ya_eliminado,true);
 assert.equal((await db.query('SELECT count(*)::int n FROM media_eliminaciones')).rows[0].n,1);
});
test('bloquea pendientes, errores inciertos y montajes sin cancelar nada',async()=>{
 for(const state of ['borrador','aprobada','programada','procesando','publicando','revision','error']){
 await db.query('UPDATE publicaciones_instagram SET status=$1 WHERE id=7',[state]);const p=await service.preview('reel',1);
 assert.equal(p.puede_eliminar,false);await assert.rejects(service.remove('reel',1,confirm(p)),{status:409});
 }
 await db.query("UPDATE publicaciones_instagram SET status='cancelada' WHERE id=7");
 await db.query("UPDATE reels_marketing SET status='procesando' WHERE id=1");
 const p=await service.preview('reel',1);assert.equal(p.puede_eliminar,false);
});
test('protege imágenes compartidas; elimina fondo y final después de descartar su reel',async()=>{
 let p=await service.preview('imagen',1);assert.equal(p.puede_eliminar,false);
 await assert.rejects(service.remove('imagen',1,confirm(p)),{status:409});
 await service.remove('reel',1,confirm(await service.preview('reel',1)));
 p=await service.preview('imagen',1);assert.equal(p.bytes_a_eliminar,6);
 await service.remove('imagen',1,confirm(p));
 const row=(await db.query('SELECT * FROM imagenes_marketing WHERE id=1')).rows[0];assert.equal(row.image_data,null);assert.equal(row.background_data,null);
 assert.ok((await db.query('SELECT image_data FROM imagenes_marketing WHERE id=2')).rows[0].image_data);
});
test('rechaza consulta obsoleta y detecta referencias legacy por URL',async()=>{
 const p=await service.preview('reel',1);
 await db.query('UPDATE publicaciones_instagram SET revision=2 WHERE id=7');
 await assert.rejects(service.remove('reel',1,confirm(p)),{status:409});
 await db.query("UPDATE publicaciones_instagram SET reel_id=NULL,status='programada' WHERE id=7");
 assert.equal((await service.preview('reel',1)).puede_eliminar,false);
});
test('rutas requieren confirmación, validan identidad y exponen estado final',async()=>{
 const app=express();app.use(express.json());registerDeletion(app,{pool:db,publicBaseUrl:'https://example.test'});
 await request(app).get('/api/medios/otro/1/eliminacion').expect(400);
 await request(app).get('/api/medios/reel/99/eliminacion').expect(404);
 await request(app).delete('/api/medios/reel/1').send({confirmacion:false}).expect(400);
 const p=(await request(app).get('/api/medios/reel/1/eliminacion').expect(200)).body;
 await request(app).delete('/api/medios/reel/1').send(confirm(p)).expect(200);
 assert.equal((await request(app).get('/api/medios/reel/1/eliminacion')).body.archivo_eliminado,true);
});
